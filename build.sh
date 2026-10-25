#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/"

typst compile --root . ./typst/resume.typ ./static/Resume.pdf
typst compile --root . ./typst/Business-Card-US.typ ./static/Business-card.svg
