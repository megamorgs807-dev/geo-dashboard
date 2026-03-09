"""
Unit tests for backend/event_store.py

Tests cover:
  - _should_corroborate() — two-tier keyword matching logic
  - Tier 1: 1 shared high-severity keyword (SEV ≥ 0.83) → corroborate
  - Tier 2: 2 shared medium-severity keywords (SEV ≥ 0.70) → corroborate
  - Negative cases: only low-severity keywords / single mid-sev → no match
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from event_store import _should_corroborate, _HIGH_SEV_KEYWORDS, _MED_SEV_KEYWORDS
from keyword_detector import SEV


# ── _should_corroborate ───────────────────────────────────────────────────────

class TestShouldCorroborate:

    # ── Tier 1: high-severity keywords (SEV ≥ 0.83) ──────────────────────────

    def test_tier1_single_high_sev_keyword_matches(self):
        """One shared high-sev keyword is enough to corroborate."""
        kws_a = ['airstrike', 'military']
        kws_b = ['airstrike', 'sanctions']
        result = _should_corroborate(kws_a, kws_b)
        assert len(result) > 0, 'Expected corroboration on shared high-sev keyword'
        assert 'airstrike' in result

    def test_tier1_invasion_matches(self):
        kws_a = ['invasion', 'troops', 'military']
        kws_b = ['invasion', 'war']
        result = _should_corroborate(kws_a, kws_b)
        assert 'invasion' in result

    def test_tier1_multiple_high_sev_returns_all_shared(self):
        kws_a = ['airstrike', 'bombing', 'war']
        kws_b = ['airstrike', 'bombing', 'sanctions']
        result = _should_corroborate(kws_a, kws_b)
        assert 'airstrike' in result
        assert 'bombing' in result

    def test_tier1_no_match_if_no_shared_high_sev(self):
        """Low-severity shared keywords alone should not trigger Tier 1."""
        kws_a = ['sanctions', 'military', 'deploy']
        kws_b = ['sanctions', 'military', 'ceasefire']
        # military is 0.60, sanctions 0.65, both below 0.83
        result = _should_corroborate(kws_a, kws_b)
        # Tier 1 should not fire; depends on whether Tier 2 fires for 2+ med-sev
        # military=0.60 is BELOW _MED_SEV_THRESHOLD (0.70), sanctions=0.65 also below
        assert len(result) == 0, f'Expected no corroboration, got {result}'

    # ── Tier 2: medium-severity keywords (SEV ≥ 0.70) ────────────────────────

    def test_tier2_two_med_sev_keywords_matches(self):
        """Two shared medium-sev keywords trigger Tier 2."""
        # missile=0.75, troops=0.72 — both ≥ 0.70 but < 0.83
        kws_a = ['missile', 'troops', 'ceasefire']
        kws_b = ['missile', 'troops', 'sanctions']
        result = _should_corroborate(kws_a, kws_b)
        assert len(result) >= 2, f'Expected Tier 2 match, got {result}'

    def test_tier2_one_med_sev_keyword_insufficient(self):
        """Only one shared medium-sev keyword should NOT trigger Tier 2."""
        kws_a = ['missile', 'ceasefire']
        kws_b = ['missile', 'negotiations']
        result = _should_corroborate(kws_a, kws_b)
        assert len(result) == 0, f'Single med-sev shared kw should not corroborate, got {result}'

    def test_tier2_blockade_and_troops_match(self):
        # blockade=0.78, troops=0.72 — both ≥ 0.70
        kws_a = ['blockade', 'troops', 'military']
        kws_b = ['blockade', 'troops', 'sanctions']
        result = _should_corroborate(kws_a, kws_b)
        assert len(result) >= 2

    # ── Edge cases ────────────────────────────────────────────────────────────

    def test_empty_keyword_lists_no_match(self):
        assert len(_should_corroborate([], [])) == 0

    def test_one_empty_list_no_match(self):
        assert len(_should_corroborate(['airstrike', 'war'], [])) == 0

    def test_no_shared_keywords_at_all(self):
        kws_a = ['airstrike', 'bombing']
        kws_b = ['ceasefire', 'negotiations']
        assert len(_should_corroborate(kws_a, kws_b)) == 0

    def test_returns_set_type(self):
        result = _should_corroborate(['airstrike'], ['airstrike'])
        assert isinstance(result, set)

    def test_non_overlapping_high_sev_no_match(self):
        """Different high-sev keywords on each side → no match."""
        kws_a = ['airstrike']
        kws_b = ['invasion']
        result = _should_corroborate(kws_a, kws_b)
        assert len(result) == 0

    def test_tier1_takes_priority_over_tier2(self):
        """When both tiers could match, Tier 1 (high-sev) result is returned."""
        # airstrike=0.85 (high), missile=0.75 (med), troops=0.72 (med)
        kws_a = ['airstrike', 'missile', 'troops']
        kws_b = ['airstrike', 'missile', 'troops']
        result = _should_corroborate(kws_a, kws_b)
        # Tier 1 fires first — result should include high-sev shared keywords
        assert 'airstrike' in result


# ── SEV threshold sets ────────────────────────────────────────────────────────

class TestThresholdSets:

    def test_high_sev_set_only_contains_correct_keywords(self):
        for kw in _HIGH_SEV_KEYWORDS:
            assert SEV[kw] >= 0.83, f'{kw} in HIGH_SEV_KEYWORDS but SEV={SEV[kw]}'

    def test_med_sev_set_only_contains_correct_keywords(self):
        for kw in _MED_SEV_KEYWORDS:
            assert SEV[kw] >= 0.70, f'{kw} in MED_SEV_KEYWORDS but SEV={SEV[kw]}'

    def test_high_sev_is_subset_of_med_sev(self):
        assert _HIGH_SEV_KEYWORDS.issubset(_MED_SEV_KEYWORDS), \
            'HIGH_SEV should be a subset of MED_SEV (all high-sev kws are also ≥ 0.70)'

    def test_known_high_sev_keywords_present(self):
        # Spot-check: these should definitely be high-severity
        for kw in ['airstrike', 'invasion', 'bombing', 'assassination', 'coup']:
            assert kw in _HIGH_SEV_KEYWORDS, f'Expected {kw!r} in HIGH_SEV_KEYWORDS'

    def test_known_low_kws_not_in_high_sev(self):
        # Ceasefire and negotiations are low-sev; should NOT be in high/med sets
        for kw in ['ceasefire', 'negotiations', 'de-escalation']:
            assert kw not in _HIGH_SEV_KEYWORDS, f'{kw!r} should not be high-sev'
            assert kw not in _MED_SEV_KEYWORDS,  f'{kw!r} should not be med-sev'
