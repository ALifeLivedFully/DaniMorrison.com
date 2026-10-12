#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

typst compile --root . ./scripts/Resume-CV/resume.typ ./static/Resume.pdf
typst compile --root . ./scripts/Resume-CV/Business-Card-US.typ ./static/Business-card.svg
