"""
Unit tests for backend/keyword_detector.py

Tests cover:
  - score_event() signal ranges and formula components
  - Negation filter (should halve weight of negated keywords)
  - extract_region() first-match region logic
  - extract_assets() market sensitivity mapping
  - extract_keywords() severity keyword detection
  - dedupe_key() normalization
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest
from keyword_detector import (
    score_event,
    extract_region,
    extract_assets,
    extract_keywords,
    dedupe_key,
    _negation_multiplier,
    _is_negated,
    SEV,
)


# ── score_event ───────────────────────────────────────────────────────────────

class TestScoreEvent:

    def test_empty_event_scores_zero_or_low(self):
        score = score_event('', '')
        assert 0 <= score <= 10, f'Empty event gave {score}, expected near 0'

    def test_score_in_valid_range(self):
        for title in [
            'Iran launches nuclear strike on US base',
            'Peace talks continue in Geneva',
            'Weather report: sunshine expected',
            'Troops mobilised along border amid rising tensions',
        ]:
            s = score_event(title)
            assert 0 <= s <= 100, f'score_event("{title}") = {s}, out of range'

    def test_high_severity_scores_high(self):
        # "nuclear strike" + "nuclear" trigger s1+s2; src_count=3 adds s3.
        # Without social velocity or geo keywords the ceiling is ~55.
        s = score_event('Iran launches nuclear strike destroying city', src_count=3)
        assert s >= 45, f'Expected high score, got {s}'

    def test_low_severity_scores_low(self):
        s = score_event('Trade negotiations making progress in Brussels')
        assert s <= 35, f'Expected low score, got {s}'

    def test_multi_source_boosts_score(self):
        base   = score_event('Airstrike reported in Damascus', src_count=1)
        multi  = score_event('Airstrike reported in Damascus', src_count=4)
        assert multi > base, 'Multi-source should score higher than single-source'

    def test_src_count_capped_at_15(self):
        score_15 = score_event('Troops deployed', src_count=4)   # 4×4=16 → cap 15
        score_50 = score_event('Troops deployed', src_count=50)  # 50×4=200 → cap 15
        assert score_15 == score_50, 'srcCount contribution should be capped at 15'

    def test_social_velocity_boosts_score(self):
        base  = score_event('Coup attempt in capital city', social_v=0.0)
        viral = score_event('Coup attempt in capital city', social_v=1.0)
        assert viral > base

    def test_desc_contributes_to_score(self):
        without = score_event('Conflict escalating')
        with_kw = score_event('Conflict escalating', 'missile strike reported near naval base')
        assert with_kw > without, 'Desc with keywords should lift score'

    def test_score_capped_at_100(self):
        # Max out all components and verify output never exceeds 100.
        # strait→s5 max; oil+semiconductor+gold→s6 max; all severity kws→s1+s2 max.
        title = ('nuclear war world war nuclear strike full-scale invasion assassination '
                 'coup ballistic missile airstrike mobilization strait naval border '
                 'oil semiconductor gold')
        s = score_event(title, desc=title, src_count=10, social_v=1.0)
        assert s <= 100, f'Score {s} exceeded cap of 100'
        assert s >= 90, f'Saturated inputs should score near 100, got {s}'


# ── Negation filter ───────────────────────────────────────────────────────────

class TestNegationFilter:

    def test_not_negated_returns_1(self):
        text = 'iran launches airstrike on military base'
        mult = _negation_multiplier(text, 'airstrike')
        assert mult == 1.0

    def test_negated_returns_0_4(self):
        text = 'iran denies airstrike on military base'
        mult = _negation_multiplier(text, 'airstrike')
        assert mult == 0.4

    def test_negation_keyword_not_present_returns_1(self):
        # Keyword not in text at all → multiplier is 1 (irrelevant but safe)
        mult = _negation_multiplier('some other text', 'nuclear war')
        assert mult == 1.0

    def test_negated_event_scores_lower(self):
        affirm  = score_event('Iran launches airstrike on US carrier group')
        negated = score_event('Iran denies any airstrike on US carrier group')
        assert affirm > negated, 'Affirmed event should score higher than negated'

    def test_risk_of_framing_reduces_score(self):
        # "risk of war" is negation-adjacent; the score should be lower than "war breaks out"
        risk_of = score_event('risk of war escalating on border')
        war_out = score_event('war breaks out on the border')
        assert war_out >= risk_of

    def test_is_negated_window_boundary(self):
        # Negation word appears >60 chars before keyword — should NOT be negated
        padding = 'x' * 70
        text = 'no ' + padding + ' airstrike'
        assert not _is_negated(text, 'airstrike', text.index('airstrike'))


# ── extract_region ────────────────────────────────────────────────────────────

class TestExtractRegion:

    def test_iran_detected(self):
        assert extract_region('IRGC forces approach strait of Hormuz') == 'IRAN'

    def test_ukraine_detected(self):
        assert extract_region('Shelling reported in Kharkiv region') == 'UKRAINE'

    def test_taiwan_detected(self):
        assert extract_region('PLA conducts exercises near Taiwan strait') == 'TAIWAN'

    def test_china_detected_when_not_taiwan(self):
        assert extract_region('China announces new economic policy') == 'CHINA'

    def test_nato_detected(self):
        assert extract_region('Pentagon increases readiness in NATO territory') == 'NATO'

    def test_global_fallback(self):
        assert extract_region('Markets react to global economic data') == 'GLOBAL'

    def test_first_match_wins(self):
        # Hormuz appears before Iran in REGION_PATTERNS → should return IRAN (hormuz maps to IRAN)
        region = extract_region('Hormuz closure would affect Iran revenue')
        assert region == 'IRAN'

    def test_case_insensitive(self):
        # extract_region lowercases internally
        assert extract_region('UKRAINE CONFLICT UPDATE') == 'UKRAINE'


# ── extract_assets ────────────────────────────────────────────────────────────

class TestExtractAssets:

    def test_oil_keywords_map_to_wti_brent(self):
        assets = extract_assets('crude oil prices rising amid tensions')
        assert 'WTI' in assets
        assert 'BRENT' in assets

    def test_taiwan_maps_to_tsm(self):
        assets = extract_assets('Taiwan semiconductor supply at risk')
        assert 'TSM' in assets

    def test_nuclear_maps_to_gld_lmt(self):
        assets = extract_assets('nuclear threat escalates')
        assert 'GLD' in assets
        assert 'LMT' in assets

    def test_no_false_positives_on_unrelated(self):
        assets = extract_assets('Local elections held across rural communities')
        assert assets == []

    def test_no_duplicate_tickers(self):
        # Multiple triggers for same ticker should not produce duplicates
        assets = extract_assets('Russia oil pipeline and crude petroleum disrupted')
        assert len(assets) == len(set(assets)), 'Duplicate tickers found'


# ── extract_keywords ──────────────────────────────────────────────────────────

class TestExtractKeywords:

    def test_detects_airstrike(self):
        assert 'airstrike' in extract_keywords('Airstrike reported in Damascus')

    def test_detects_multiple(self):
        kws = extract_keywords('Coup attempt followed by airstrike on military base')
        assert 'coup' in kws
        assert 'airstrike' in kws
        assert 'military' in kws

    def test_no_keywords_on_benign_text(self):
        kws = extract_keywords('City council approves new park budget')
        assert kws == []

    def test_case_insensitive_matching(self):
        kws = extract_keywords('AIRSTRIKE confirmed by defence ministry')
        assert 'airstrike' in kws


# ── dedupe_key ────────────────────────────────────────────────────────────────

class TestDedupeKey:

    def test_strips_special_chars(self):
        assert dedupe_key('Iran: Launches — Airstrike!') == 'iranlaunchesairstrike'

    def test_lowercases(self):
        assert dedupe_key('UKRAINE WAR UPDATE') == 'ukrainewarupdate'

    def test_truncates_at_48(self):
        long_title = 'a' * 100
        assert len(dedupe_key(long_title)) == 48

    def test_same_title_same_key(self):
        t = 'Russia shells Kyiv overnight'
        assert dedupe_key(t) == dedupe_key(t)

    def test_different_titles_different_keys(self):
        assert dedupe_key('Iran launches missile') != dedupe_key('Russia deploys troops')


# ── SEV table sanity ──────────────────────────────────────────────────────────

class TestSevTable:

    def test_all_weights_in_range(self):
        for kw, w in SEV.items():
            assert 0.0 < w <= 1.0, f'SEV["{kw}"] = {w} is out of range (0, 1]'

    def test_nuclear_war_is_highest(self):
        assert SEV['nuclear war'] >= max(SEV.values()) - 0.01

    def test_deescalation_is_low(self):
        assert SEV['de-escalation'] < 0.30

    def test_no_empty_keywords(self):
        for kw in SEV:
            assert kw.strip() != '', 'Empty string found as SEV keyword'
