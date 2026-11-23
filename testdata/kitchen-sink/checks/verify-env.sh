#!/usr/bin/env bash
errors=0

if [ -z "${KS_ENV_VAR:-}" ]; then
    echo "FAIL: KS_ENV_VAR not set"
    errors=$((errors + 1))
else
    echo "OK: KS_ENV_VAR=$KS_ENV_VAR"
fi

if [ -z "${KS_COUNTER:-}" ]; then
    echo "FAIL: KS_COUNTER not set"
    errors=$((errors + 1))
else
    echo "OK: KS_COUNTER=$KS_COUNTER"
fi

if [ -n "${KS_EXPORT_ONLY:-}" ]; then
    echo "FAIL: KS_EXPORT_ONLY is set, but an export should stay in its own script"
    errors=$((errors + 1))
else
    echo "OK: KS_EXPORT_ONLY not set"
fi

[ $errors -gt 0 ] && exit 1
exit 0
