"""What is due, from the dates of what each site has saved (cadence.js), in a
real Chromium. Ported from PaperPull's own tests of these rules
(core/tests/test_status_tool.py), with the tax season added. Every test pins
the day, so none depends on when it runs."""
from datetime import date, timedelta
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
TYPES = {".js": "text/javascript", ".html": "text/html", ".css": "text/css"}
TODAY = date(2026, 11, 9)


@pytest.fixture(scope="module")
def tab():
    def serve(route):
        path = ROOT / route.request.url[len(BASE):].split("?")[0]
        if path.is_file():
            route.fulfill(status=200, content_type=TYPES.get(path.suffix, "text/plain"), body=path.read_text())
        else:
            route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>x</title>")
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        t.route(BASE + "**", serve)
        t.goto(BASE)
        yield t
        b.close()


def call(tab, name, *args):
    return tab.evaluate(f"async (a) => (await import('/cadence.js')).{name}(...a)", list(args))


def record(series, tax=()):
    """{series: [date, ...]} as the extension keeps it: an id per document,
    holding its series and date, and its date."""
    dates = {}
    for name, days in series.items():
        for d in days:
            dates[f"{name}:{d.isoformat()}" if name else d.isoformat()] = d.isoformat()
    return {"ids": list(dates), "dates": dates, "tax": [i for i in dates if any(i.startswith(f"{t}:") for t in tax)]}


def status(tab, series, today=TODAY, tax=()):
    return call(tab, "siteStatus", record(series, tax), today.isoformat())


def every(n, end=TODAY, gap=30):
    """n documents `gap` days apart, the newest on `end` (status.py _monthly)."""
    return [end - timedelta(days=gap * i) for i in range(n)]


def months(n, skip=(), start=date(2020, 1, 15), step=30):
    """status.py _months."""
    return [start + timedelta(days=step * i) for i in range(n) if i not in skip]


def offsets(start, days):
    s = date.fromisoformat(start)
    return [s + timedelta(days=d) for d in days]


def raw_gaps(tab, series):
    return tab.evaluate("""async (s) => {
      const c = await import('/cadence.js');
      return c.findGaps(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.map(c.dayOf)])));
    }""", {k: [d.isoformat() for d in v] for k, v in series.items()})


# -- dates from ids, and the backfill ------------------------------------------------
@pytest.mark.parametrize("id,want", [
    ("2026-09-30_account_statement", "2026-09-30"),
    ("card:2026-10-28", "2026-10-28"),
    ("4821-2026-09-15", "2026-09-15"),
    ("receipt-X-2025-02-10-1234", "2025-02-10"),
    ("2026-08", "2026-08-31"),
    ("2024-02", "2024-02-29"),
    ("2026-08-balance", "2026-08-31"),
    ("A|1234|2026-03-31", "2026-03-31"),
    ("2026-01-01-to-2026-02-01", None),
    ("2026-02-30_statement", None),
    ("e5f1a2b3c4", None),
    ("12026-08", None),
    ("x-20260930", None),
    ("tax-1099:abc", None),
])
def test_a_date_is_taken_from_an_id_only_when_it_is_unambiguous(tab, id, want):
    assert call(tab, "dateFromId", id) == want


def test_the_backfill_fills_only_what_is_missing_and_is_idempotent(tab):
    stored = {"seen:chase": ["card:2026-10-28", "card:2026-09-28", "opaque", "tax-1099:x"],
              "dates:chase": {"card:2026-10-28": "2026-10-27", "opaque": "2026-08-01"}}
    got = call(tab, "recordOf", stored, "chase")
    assert got["dates"] == {"card:2026-10-28": "2026-10-27", "opaque": "2026-08-01", "card:2026-09-28": "2026-09-28"}
    assert got["tax"] == ["tax-1099:x"]
    writes = call(tab, "backfillFor", stored, "chase")
    assert writes["dates:chase"] == got["dates"] and writes["tax:chase"] == ["tax-1099:x"]
    assert call(tab, "backfillFor", {**stored, **writes}, "chase") == {}


def test_a_stored_value_that_is_not_a_date_is_ignored(tab):
    got = call(tab, "recordOf", {"seen:amex": ["a"], "dates:amex": {"a": "yesterday", "b": 5}}, "amex")
    assert got["dates"] == {}


@pytest.mark.parametrize("title,tax", [
    ("1099-B Tax Form", True), ("Consolidated 1099", True), ("Form 1098-E", True), ("5498 Tax Form", True),
    ("1099-INT", True), ("Realized Gains Tax Document", True), ("Account Transcript", True), ("Gain/Loss Report", True),
    ("Monthly Statement", False), ("Property Tax Notice", False), ("Utility Bill", False), ("Tax Bill 2025", False),
])
def test_tax_forms_are_known_by_their_title(tab, title, tax):
    assert call(tab, "isTaxDocument", {"id": "x", "title": title}) is tax


# -- many series on one site, each monthly (status.py _cadence_days) ---------------------
def test_many_accounts_each_monthly_is_not_read_as_weekly(tab):
    s = status(tab, {f"acct{a}": every(12, end=TODAY - timedelta(days=a)) for a in range(10)})
    assert 25 <= s["cadenceDays"] <= 35 and s["status"] == "current" and s["cadence"] == "monthly"


# -- the due / overdue thresholds ---------------------------------------------------------
@pytest.mark.parametrize("age,want", [(5, "current"), (30, "current"), (39, "current"), (40, "due"), (50, "due"), (60, "due"), (61, "overdue"), (95, "overdue")])
def test_status_thresholds_for_a_monthly_site(tab, age, want):
    # 1.3 and 2 times the 30 day cadence: 39 days is current, 60 is due.
    assert status(tab, {"": every(12, end=TODAY - timedelta(days=age))})["status"] == want


def test_a_yearly_site_is_not_overdue_after_two_hundred_days(tab):
    s = status(tab, {"": every(5, gap=365, end=TODAY - timedelta(days=200))})
    assert s["status"] == "current" and s["cadence"] == "yearly"


def test_a_quarterly_site_is_named_quarterly(tab):
    s = status(tab, {"": every(8, gap=91, end=TODAY - timedelta(days=20))})
    assert s["status"] == "current" and s["cadence"] == "quarterly"


@pytest.mark.parametrize("days,name", [(7, "weekly"), (14, "2x month"), (30, "monthly"), (91, "quarterly"), (182, "2x year"), (365, "yearly"), (None, "")])
def test_cadence_names_match_paperpull(tab, days, name):
    assert call(tab, "cadenceName", days) == name


def test_too_little_history_says_so_rather_than_guessing(tab):
    assert status(tab, {"": every(1)})["status"] == "unknown"
    assert status(tab, {"": every(2)})["status"] == "unknown"
    assert status(tab, {"": every(3)})["status"] == "current"


def test_ids_with_no_date_are_too_little_history(tab):
    s = call(tab, "siteStatus", {"ids": ["a", "b", "c"]}, TODAY.isoformat())
    assert s["status"] == "unknown" and s["documents"] == 3


def test_nothing_saved_is_never(tab):
    assert call(tab, "siteStatus", {}, TODAY.isoformat())["status"] == "never"


def test_a_future_dated_record_cannot_mask_a_stale_site(tab):
    s = status(tab, {"S": months(30, start=TODAY - timedelta(days=2000)) + [TODAY + timedelta(days=95)]})
    assert s["status"] == "overdue"


def test_the_expected_date_is_the_newest_plus_the_cadence(tab):
    s = status(tab, {"": every(12, end=date(2026, 10, 31))})
    assert (s["newest"], s["expected"]) == ("2026-10-31", "2026-11-30")


# -- gaps in the middle of a history (status.py find_gaps) --------------------------------
def test_a_missing_month_in_a_monthly_series_is_found(tab):
    gaps = raw_gaps(tab, {"S": months(24, skip={10})})
    assert len(gaps) == 1 and gaps[0]["missing"] == 1


def test_several_consecutive_missing_months_are_counted(tab):
    gaps = raw_gaps(tab, {"S": months(24, skip={10, 11, 12})})
    assert len(gaps) == 1 and gaps[0]["missing"] == 3


def test_a_complete_series_reports_nothing(tab):
    assert raw_gaps(tab, {"S": months(24)}) == []


def test_normal_jitter_is_not_a_gap(tab):
    assert raw_gaps(tab, {"S": offsets("2020-01-10", [0, 29, 62, 90, 121, 152, 179, 213, 240, 272, 301, 335, 365, 394])}) == []


def test_an_irregular_series_is_left_alone(tab):
    assert raw_gaps(tab, {"S": offsets("2020-01-01", [0, 16, 42, 119, 207, 365, 545, 731])}) == []


def test_a_short_history_is_not_judged(tab):
    # Six documents at least: five with a hole between them say nothing.
    assert raw_gaps(tab, {"S": months(6, skip={3})}) == []
    assert len(raw_gaps(tab, {"S": months(7, skip={3})})) == 1


def test_each_series_is_judged_separately(tab):
    assert raw_gaps(tab, {"Monthly Statement": months(24), "Yearly Tax Form": months(4, step=365)}) == []


def test_the_same_window_across_accounts_is_reported_once(tab):
    series = {a: months(24, skip={10}) for a in "ABC"}
    assert len(raw_gaps(tab, series)) == 3
    s = status(tab, series, today=date(2022, 1, 1))
    assert len(s["gaps"]) == 1 and s["gaps"][0]["count"] == 3 and s["gaps"][0]["missing"] == 1


def test_monthly_going_quarterly_is_not_reported_as_gaps(tab):
    days = [date(2024, 1, 15) + timedelta(days=30 * i) for i in range(24)] + offsets("2025-12-10", [90, 180, 270])
    assert raw_gaps(tab, {"S": days}) == []


def test_a_real_hole_before_a_cadence_change_is_still_reported(tab):
    days = [date(2024, 1, 15) + timedelta(days=30 * i) for i in range(12)] + offsets("2024-12-10", [60, 90, 120, 150]) + offsets("2025-06-10", [90, 180, 270])
    assert raw_gaps(tab, {"S": days})


def test_an_irregular_start_still_reports_its_gaps(tab):
    days = offsets("2018-04-30", [0, 61, 153, 214]) + offsets("2019-01-31", [30 * i for i in range(24)])
    assert raw_gaps(tab, {"S": days})


def test_a_steady_tail_at_the_same_speed_excuses_nothing(tab):
    days = [date(2024, 1, 15) + timedelta(days=30 * i) for i in range(12)] + offsets("2024-12-10", [60]) + offsets("2025-02-10", [30 * i for i in range(1, 13)])
    assert raw_gaps(tab, {"S": days})


def test_an_absurd_date_cannot_invent_thousands_of_missing_documents(tab):
    s = status(tab, {"S": every(30) + [date(1, 1, 1)]})
    assert s["gaps"] == []


# -- different kinds of document on one site --------------------------------------------
def test_yearly_tax_forms_do_not_make_a_monthly_site_irregular_or_current(tab):
    statements = every(24, end=TODAY - timedelta(days=10))
    forms = [date(y, 1, 31) for y in (2023, 2024, 2025, 2026)]
    s = status(tab, {"card": statements, "tax-1099": forms}, tax=["tax-1099"])
    assert s["cadence"] == "monthly" and s["status"] == "current" and s["gaps"] == []
    # A form newer than the statements does not make a late site look current.
    late = status(tab, {"card": every(24, end=TODAY - timedelta(days=95)), "tax-1099": [TODAY - timedelta(days=3)]}, tax=["tax-1099"])
    assert late["status"] == "overdue" and late["newest"] == (TODAY - timedelta(days=95)).isoformat()


def test_a_site_with_only_tax_forms_is_judged_by_them(tab):
    s = status(tab, {"tax-1099": [date(y, 12, 31) for y in range(2021, 2026)]}, tax=["tax-1099"])
    assert s["cadence"] == "yearly" and s["status"] == "current"


# -- the tax season ---------------------------------------------------------------------
FORMS = {"card": every(12, end=date(2027, 1, 1)), "tax-1099": [date(2025, 2, 14), date(2024, 2, 15)]}


@pytest.mark.parametrize("today,state,year", [
    (date(2027, 1, 14), "before", 2026),
    (date(2027, 1, 15), "due", 2026),
    (date(2027, 2, 20), "due", 2026),
    (date(2027, 3, 15), "due", 2026),
    (date(2027, 3, 16), "missing", 2026),
    (date(2027, 11, 9), "missing", 2026),
])
def test_tax_forms_are_due_only_in_their_season(tab, today, state, year):
    s = status(tab, FORMS, today=today, tax=["tax-1099"])
    assert s["tax"] == {"state": state, "year": year}


def test_inside_the_window_a_site_with_last_years_forms_is_not_due_for_them(tab):
    forms = {**FORMS, "tax-1099": [date(2026, 2, 13), date(2027, 1, 28)]}
    s = status(tab, forms, today=date(2027, 2, 1), tax=["tax-1099"])
    assert s["tax"] == {"state": "have", "year": 2026}
    # A form dated at the tax year's end counts for that year.
    s = status(tab, {**FORMS, "tax-1099": [date(2026, 12, 31)]}, today=date(2027, 2, 1), tax=["tax-1099"])
    assert s["tax"]["state"] == "have"


def test_a_site_that_never_had_tax_forms_is_never_due_for_them(tab):
    s = status(tab, {"card": every(12, end=date(2027, 2, 1))}, today=date(2027, 2, 1))
    assert s["tax"] is None and call(tab, "stateOf", s) == "current" and not call(tab, "isDue", s)


def test_the_year_rolls_over_on_new_years_day(tab):
    forms = {"card": every(12, end=date(2026, 12, 20)), "tax-1099": [date(2026, 2, 13)]}
    assert status(tab, forms, today=date(2026, 12, 31), tax=["tax-1099"])["tax"] == {"state": "have", "year": 2025}
    assert status(tab, forms, today=date(2027, 1, 1), tax=["tax-1099"])["tax"] == {"state": "before", "year": 2026}
    assert status(tab, forms, today=date(2027, 1, 15), tax=["tax-1099"])["tax"] == {"state": "due", "year": 2026}


def test_tax_forms_in_season_make_an_up_to_date_site_due_and_run(tab):
    s = status(tab, FORMS, today=date(2027, 1, 20), tax=["tax-1099"])
    assert s["status"] == "current" and call(tab, "stateOf", s) == "tax"
    assert call(tab, "needsRun", s) and call(tab, "isDue", s)
    fresh = {**FORMS, "card": every(12, end=date(2027, 3, 10))}
    after = status(tab, fresh, today=date(2027, 3, 20), tax=["tax-1099"])
    assert after["status"] == "current" and not call(tab, "isDue", after) and not call(tab, "needsRun", after)


# -- in words -------------------------------------------------------------------------
def words(tab, s, today=TODAY, **kw):
    return call(tab, "statusWords", s, today.isoformat(), kw)


def test_the_status_in_plain_words(tab):
    assert words(tab, status(tab, {"": every(12, end=date(2026, 10, 31))})) == "Up to date · next around Nov 30"
    assert words(tab, status(tab, {"": every(12, end=date(2026, 10, 31))}), skipped=True) == "Not due yet · next around Nov 30"
    assert words(tab, status(tab, {"": every(12, end=TODAY - timedelta(days=35))})) == "Up to date · next one expected any day"
    assert words(tab, status(tab, {"": every(12, end=date(2026, 9, 25))})) == "New one likely · expected around Oct 25"
    assert words(tab, status(tab, {"": every(12, end=date(2026, 8, 31))})) == "Overdue by 40 days · newest Aug 31"
    assert words(tab, status(tab, {"": every(2)})) == "No schedule yet · 2 saved, newest Nov 9"
    assert words(tab, call(tab, "siteStatus", {}, TODAY.isoformat())) == "Nothing saved yet"


def test_a_year_other_than_this_one_is_named(tab):
    assert words(tab, status(tab, {"": every(12, end=date(2025, 12, 31))}), today=date(2026, 6, 1)).endswith("newest Dec 31, 2025")


def test_a_gap_names_its_month(tab):
    monthly = [date(2026, m, 28) for m in range(1, 11) if m != 3]
    assert words(tab, status(tab, {"S": monthly})) == "Up to date · next around Nov 28 · Possible gap: Mar 2026"
    many = [date(2025, m, 28) for m in range(1, 13) if m not in (11, 12)] + [date(2026, m, 28) for m in range(2, 11)]
    assert words(tab, status(tab, {"S": many})).endswith("Possible gap: Nov 2025–Jan 2026 (3 missing)")


def test_tax_forms_are_said_beside_the_statement_status(tab):
    assert words(tab, status(tab, FORMS, today=date(2027, 1, 20), tax=["tax-1099"]), today=date(2027, 1, 20)) == "Up to date · next around Jan 31 · Tax forms expected now (2026)"
    assert words(tab, status(tab, FORMS, today=date(2027, 3, 20), tax=["tax-1099"]), today=date(2027, 3, 20)).endswith("2026 tax forms not found yet")


# -- what needs running, and in what order ------------------------------------------------
def test_get_new_runs_all_but_the_up_to_date(tab):
    cases = {"current": every(12), "due": every(12, end=TODAY - timedelta(days=50)), "overdue": every(12, end=TODAY - timedelta(days=95)),
             "gap": months(24, skip={10}, start=TODAY - timedelta(days=30 * 23)), "unknown": every(1)}
    for want, days in cases.items():
        s = status(tab, {"S": days})
        assert call(tab, "stateOf", s) == want
        assert call(tab, "needsRun", s) is (want != "current")
        assert call(tab, "isDue", s) is (want in ("due", "overdue"))
    never = call(tab, "siteStatus", {}, TODAY.isoformat())
    assert call(tab, "needsRun", never) and not call(tab, "isDue", never)


def test_the_order_is_paperpulls_most_in_need_first(tab):
    ranks = [call(tab, "rankOf", status(tab, {"S": d})) for d in (
        every(12, end=TODAY - timedelta(days=95)), every(12, end=TODAY - timedelta(days=50)),
        months(24, skip={10}, start=TODAY - timedelta(days=30 * 23)), every(1), every(12))]
    ranks.insert(3, call(tab, "rankOf", call(tab, "siteStatus", {}, TODAY.isoformat())))
    assert ranks == sorted(ranks) and len(set(ranks)) == 6


def test_a_dismissed_gap_is_not_shown_or_counted_but_a_new_one_is(tab):
    monthly = [date(2026, m, 28) for m in range(1, 11) if m != 3]
    rec = record({"S": monthly})
    first = call(tab, "siteStatus", rec, TODAY.isoformat())
    assert len(first["gaps"]) == 1 and call(tab, "needsRun", first) is True
    key = call(tab, "gapKey", first["gaps"][0])
    quiet = call(tab, "siteStatus", {**rec, "gapsOk": [key]}, TODAY.isoformat())
    assert quiet["gaps"] == [] and quiet["gapsDismissed"] == 1
    assert words(tab, quiet) == "Up to date · next around Nov 28" and call(tab, "needsRun", quiet) is False
    # Another month missing later is a new window, so it is flagged.
    later = [d for d in monthly if d.month != 7]
    again = call(tab, "siteStatus", {**record({"S": later}), "gapsOk": [key]}, TODAY.isoformat())
    assert [call(tab, "gapWords", g) for g in again["gaps"]] == ["Jul 2026"]


def test_dismissed_gaps_are_read_from_storage(tab):
    got = call(tab, "recordOf", {"seen:x": ["card:2026-01-28"], "gapsOk:x": ["2026-02-28|2026-04-28", 5]}, "x")
    assert got["gapsOk"] == ["2026-02-28|2026-04-28"]



# ---- checked, nothing new; posting delay ------------------------------------

def with_extra(series, **extra):
    r = record(series)
    r.update(extra)
    return r


def test_a_due_site_checked_since_its_newest_waits_a_few_days(tab):
    days = every(12, end=TODAY - timedelta(days=41))
    checked = (TODAY - timedelta(days=1)).isoformat()
    got = call(tab, "siteStatus", with_extra({"s": days}, checked=checked), TODAY.isoformat())
    assert got["status"] == "checked"
    assert got["nextCheck"] == (TODAY + timedelta(days=6)).isoformat()
    assert call(tab, "needsRun", got) is False and call(tab, "isDue", got) is False
    assert "nothing new yet" in call(tab, "statusWords", got, TODAY.isoformat())


def test_the_check_runs_out(tab):
    days = every(12, end=TODAY - timedelta(days=41))
    checked = (TODAY - timedelta(days=8)).isoformat()
    got = call(tab, "siteStatus", with_extra({"s": days}, checked=checked), TODAY.isoformat())
    assert got["status"] == "due"


def test_a_check_before_the_newest_counts_for_nothing(tab):
    days = every(12, end=TODAY - timedelta(days=41))
    checked = (TODAY - timedelta(days=50)).isoformat()
    got = call(tab, "siteStatus", with_extra({"s": days}, checked=checked), TODAY.isoformat())
    assert got["status"] == "due"


def test_a_current_site_stays_current_when_checked(tab):
    got = call(tab, "siteStatus", with_extra({"s": every(12)}, checked=TODAY.isoformat()), TODAY.isoformat())
    assert got["status"] == "current"


def test_the_posting_delay_is_learned_from_on_time_arrivals(tab):
    days = every(12, end=TODAY - timedelta(days=41))
    r = record({"s": days})
    ids = sorted(r["ids"], key=lambda i: r["dates"][i])
    # The newest three arrived 12 days after their date; the rest years late.
    arrived = {i: (date.fromisoformat(r["dates"][i]) + timedelta(days=12)).isoformat() for i in ids[-3:]}
    arrived.update({i: "2026-11-01" for i in ids[:-3]})
    r["arrived"] = arrived
    got = call(tab, "siteStatus", r, TODAY.isoformat())
    assert got["lagDays"] == 12 and got["status"] == "current"
    assert got["expected"] == (days[0] + timedelta(days=42)).isoformat()


def test_one_arrival_teaches_nothing(tab):
    days = every(12, end=TODAY - timedelta(days=41))
    r = record({"s": days})
    newest = max(r["ids"], key=lambda i: r["dates"][i])
    r["arrived"] = {newest: (days[0] + timedelta(days=12)).isoformat()}
    assert call(tab, "siteStatus", r, TODAY.isoformat())["lagDays"] == 0


def test_the_record_reads_arrivals_and_checks(tab):
    stored = {"seen:s": ["a"], "dates:s": {"a": "2026-10-01"}, "arrived:s": {"a": "2026-10-09", "b": "nope"}, "checked:s": "2026-11-01"}
    got = call(tab, "recordOf", stored, "s")
    assert got["arrived"] == {"a": "2026-10-09"} and got["checked"] == "2026-11-01"
    assert call(tab, "keysFor", "s")[-2:] == ["arrived:s", "checked:s"]
