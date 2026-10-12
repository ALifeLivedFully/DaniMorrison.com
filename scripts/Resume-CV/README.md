# Resume tailoring variants

`data.json` is the master file — every bullet you've ever written, tagged
with keywords. A variant file lets you pick a subset for a specific job
application without duplicating the whole resume.

## Variant file format

```json
{
  "title": "Senior Backend Engineer",
  "summary": "Custom summary text for this role.",
  "tags": ["backend", "kubernetes", "leadership"],
  "max_bullets_per_entry": 3
}
```

All fields are optional:

- `title` / `summary` — override the ones in data.json.
- `tags` — bullets/projects matching ANY of these tags are kept. Everything
  else for that job is dropped. If a job has no bullets matching the
  tags, ALL of its bullets are shown instead — tailoring will never
  blank out an entire job by accident.
- `max_bullets_per_entry` — cap on bullets shown per job/project, applied
  after tag filtering. Useful for keeping a tailored resume to one page.

## Adding tags to your master data

In `data.json`, each bullet is an object, not a plain string:

```json
{ "text": "Migrated 12 legacy services to Kubernetes...", "tags": ["kubernetes", "backend", "infrastructure"] }
```

Tag with whatever keywords matter for the roles you apply to — technology
names, skill areas (leadership, testing, product), or industries (fintech,
healthcare). A bullet can have as many tags as make sense.

## Compiling with a variant

```
typst compile resume.typ resume.pdf --input variant=variants/backend.json
```

No `--input variant=...` → the full, untailored resume (all bullets shown).

## Python CLI & Management Tool (`resume.py`)

A Python program (`resume.py`) is included to automate master data management, variant generation, tag exploration, job description matching, and PDF compilation. It uses only the Python standard library.

### Quick Start

```bash
# Launch interactive menu
./resume.py

# Or use specific commands:
./resume.py preview                  # Preview base resume in terminal
./resume.py preview backend          # Preview 'backend' variant with match/drop breakdown
./resume.py build                    # Compile base resume to resume.pdf
./resume.py build --variant backend  # Compile variant to dist/resume-backend.pdf
./resume.py build --all              # Compile base resume + all variants at once
```

### Tailoring to a Job Posting

Instead of manually picking keywords, pass a job posting text or file to automatically match against your tags:

```bash
# Scan a job description and suggest variant tags:
./resume.py variant match "job_posting.txt"

# Or auto-create the variant directly:
./resume.py variant match "job_posting.txt" --save stripe-backend --max-bullets 3
```

### Managing Variants

```bash
./resume.py variant list             # List all variants with overrides and tag counts
./resume.py variant create <name>    # Create a new variant (supports interactive wizard or flags)
./resume.py variant edit <name>      # Edit fields interactively or in $EDITOR
./resume.py variant delete <name>    # Remove a variant
```

### Managing Master Data & Tags

```bash
./resume.py data show                # View summary of all experiences, skills, and projects
./resume.py data tags                # Visual tag histogram, bullet counts, untagged bullet detector
./resume.py data retag <old> <new>   # Rename or merge tags across data.json and all variants
./resume.py data add-bullet          # Add a bullet with tags to any job or project
./resume.py data add-job             # Add a new job experience entry
./resume.py data add-project         # Add a new project
./resume.py data add-skill           # Add skills or categories
./resume.py data validate            # Check schema integrity, missing fields, broken URLs
./resume.py data edit                # Open data.json in $EDITOR with backup and validation
```

## Workflow suggestion

1. Read the job posting or run `./resume.py variant match <job.txt> --save <company-role>`.
2. Run `./resume.py preview <company-role>` to see which bullets match and which are dropped.
3. Build the PDF: `./resume.py build --variant <company-role>`.
4. Keep `variants/` out of version control if it reveals which companies
   you're applying to and that bothers you — or don't, it's just JSON.
