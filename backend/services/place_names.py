"""Conservative airport aliases; do not turn an ordinary city into an airport."""
import re

AIRPORT_ALIASES = {
    "부산김해": "김해국제공항",
    "부산김해공항": "김해국제공항",
    "부산김해국제공항": "김해국제공항",
    "김해공항": "김해국제공항",
    "김해국제공항": "김해국제공항",
    "PUS": "김해국제공항",
    "RKPK": "김해국제공항",
    "GIMHAEAIRPORT": "김해국제공항",
    "GIMHAEINTERNATIONALAIRPORT": "김해국제공항",
    "인천공항": "인천국제공항",
    "ICN": "인천국제공항",
    "김포공항": "김포국제공항",
    "GMP": "김포국제공항",
    "제주공항": "제주국제공항",
    "CJU": "제주국제공항",
}


def normalize_place_name(value):
    value = value.strip()
    compact = re.sub(r"\s+", "", value).upper()
    if compact in AIRPORT_ALIASES:
        return AIRPORT_ALIASES[compact]
    # Preserve terminal/address qualifiers in e.g. "PUS, 국내선 터미널".
    head, separator, tail = value.partition(',')
    canonical = AIRPORT_ALIASES.get(re.sub(r"\s+", "", head).upper())
    if separator and canonical:
        return f"{canonical}, {tail.strip()}"
    return value
