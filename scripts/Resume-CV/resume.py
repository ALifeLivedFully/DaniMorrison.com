#!/usr/bin/env python3
"""
Resume & CV Manager for Typst
-----------------------------
A comprehensive CLI and interactive tool to:
  - Inspect, edit, and validate master resume data (data.json)
  - Create a new data file from scratch when data.json is missing (init wizard)
  - Create, modify, preview, and match variants (variants/*.json)
  - Explore and manage tags across bullets and projects
  - Analyze job postings and suggest tailored tags
  - Build/compile base and tailored PDFs using Typst
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

# Base paths
BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data.json"
VARIANTS_DIR = BASE_DIR / "variants"
TYPST_FILE = BASE_DIR / "resume.typ"
DIST_DIR = BASE_DIR / "dist"

# Terminal ANSI Styling
class Style:
    _USE_COLOR = sys.stdout.isatty() and not os.environ.get("NO_COLOR")

    RESET = "\033[0m" if _USE_COLOR else ""
    BOLD = "\033[1m" if _USE_COLOR else ""
    DIM = "\033[2m" if _USE_COLOR else ""
    ITALIC = "\033[3m" if _USE_COLOR else ""
    UNDERLINE = "\033[4m" if _USE_COLOR else ""

    RED = "\033[31m" if _USE_COLOR else ""
    GREEN = "\033[32m" if _USE_COLOR else ""
    YELLOW = "\033[33m" if _USE_COLOR else ""
    BLUE = "\033[34m" if _USE_COLOR else ""
    MAGENTA = "\033[35m" if _USE_COLOR else ""
    CYAN = "\033[36m" if _USE_COLOR else ""
    WHITE = "\033[37m" if _USE_COLOR else ""

def print_header(title: str) -> None:
    print(f"\n{Style.BOLD}{Style.CYAN}══ {title} {'═' * max(2, 60 - len(title))}{Style.RESET}")

def print_success(msg: str) -> None:
    print(f"{Style.GREEN}✓ {msg}{Style.RESET}")

def print_warning(msg: str) -> None:
    print(f"{Style.YELLOW}⚠ {msg}{Style.RESET}")

def print_error(msg: str) -> None:
    print(f"{Style.RED}✗ {msg}{Style.RESET}", file=sys.stderr)

def print_info(msg: str) -> None:
    print(f"{Style.BLUE}ℹ {msg}{Style.RESET}")


# ---------------------------------------------------------------------------
# Backup & JSON File I/O
# ---------------------------------------------------------------------------

def create_backup(path: Path) -> Optional[Path]:
    """Creates a .bak copy before modifying any file."""
    if not path.exists():
        return None
    backup_path = path.with_suffix(path.suffix + ".bak")
    try:
        shutil.copy2(path, backup_path)
        return backup_path
    except Exception as e:
        print_warning(f"Could not create backup for {path.name}: {e}")
        return None

def load_data(path: Path = DATA_FILE) -> Dict[str, Any]:
    """Loads and returns the master data dictionary."""
    if not path.exists():
        print_error(f"Data file not found at {path}")
        sys.exit(1)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        print_error(f"Malformed JSON in {path.name}: {e}")
        sys.exit(1)

def save_data(data: Dict[str, Any], path: Path = DATA_FILE, make_backup: bool = True) -> None:
    """Saves the master data dictionary nicely formatted."""
    if make_backup:
        create_backup(path)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

def list_variants() -> List[str]:
    """Returns sorted names of all available variants without .json suffix."""
    if not VARIANTS_DIR.exists():
        return []
    return sorted(f.stem for f in VARIANTS_DIR.glob("*.json"))

def load_variant(name: str) -> Tuple[str, Dict[str, Any]]:
    """Loads a variant by name or path."""
    name_clean = name.replace(".json", "")
    variant_file = VARIANTS_DIR / f"{name_clean}.json"
    if not variant_file.exists():
        # Maybe user passed a direct path
        cand = Path(name)
        if cand.exists():
            variant_file = cand
            name_clean = cand.stem
        else:
            print_error(f"Variant '{name}' not found in {VARIANTS_DIR}")
            sys.exit(1)

    try:
        with open(variant_file, "r", encoding="utf-8") as f:
            return name_clean, json.load(f)
    except json.JSONDecodeError as e:
        print_error(f"Malformed JSON in variant file {variant_file.name}: {e}")
        sys.exit(1)

def save_variant(name: str, variant_data: Dict[str, Any], make_backup: bool = True) -> Path:
    """Saves a variant to variants/<name>.json."""
    VARIANTS_DIR.mkdir(parents=True, exist_ok=True)
    name_clean = name.replace(".json", "")
    variant_file = VARIANTS_DIR / f"{name_clean}.json"
    if make_backup and variant_file.exists():
        create_backup(variant_file)
    with open(variant_file, "w", encoding="utf-8") as f:
        json.dump(variant_data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return variant_file


# ---------------------------------------------------------------------------
# Tailoring & Typst Simulation Engine
# ---------------------------------------------------------------------------

@dataclass
class BulletStatus:
    text: str
    tags: List[str]
    matched: bool
    included: bool
    reason: str  # 'tag_match', 'fallback', 'dropped_tag', 'dropped_max_cap'

@dataclass
class TailoredJob:
    company: str
    role: str
    dates: str
    location: str
    bullets: List[BulletStatus]
    is_fallback: bool

@dataclass
class TailoredProject:
    name: str
    tech: str
    tags: List[str]
    is_entry_matched: bool
    bullets: List[BulletStatus]
    is_fallback: bool

@dataclass
class TailoredResume:
    title: str
    title_overridden: bool
    summary: str
    summary_overridden: bool
    jobs: List[TailoredJob]
    projects: List[TailoredProject]
    variant_tags: List[str]
    max_bullets: Optional[int]
    total_bullets_included: int
    total_bullets_available: int

def simulate_variant(data: Dict[str, Any], variant: Optional[Dict[str, Any]] = None) -> TailoredResume:
    """
    Simulates the exact Typst filtering logic found in resume.typ:
    - If v-tags is empty: shows all bullets and entries.
    - If bullets match ANY tag in v-tags: matched bullets are kept.
    - If NO bullets in a job match: falls back to showing ALL bullets for that job.
    - max_bullets_per_entry caps bullets after filtering.
    - Projects match if project tags intersect v-tags; fallback to all if none match.
    """
    if variant is None:
        variant = {}

    v_tags = variant.get("tags", [])
    max_bullets = variant.get("max_bullets_per_entry")

    # Title & Summary overrides
    effective_title = variant.get("title", data.get("title", ""))
    effective_summary = variant.get("summary", data.get("summary", ""))
    title_overridden = "title" in variant and variant["title"] != data.get("title", "")
    summary_overridden = "summary" in variant and variant["summary"] != data.get("summary", "")

    # Experience filtering
    tailored_jobs: List[TailoredJob] = []
    total_inc = 0
    total_avail = 0

    for job in data.get("experience", []):
        raw_bullets = job.get("bullets", [])
        total_avail += len(raw_bullets)

        parsed_bullets: List[Tuple[str, List[str], bool]] = []
        for b in raw_bullets:
            if isinstance(b, dict):
                text = b.get("text", "")
                tags = b.get("tags", [])
            else:
                text = str(b)
                tags = []
            has_match = any(t in v_tags for t in tags) if v_tags else True
            parsed_bullets.append((text, tags, has_match))

        matched_list = [p for p in parsed_bullets if p[2]]
        is_fallback = False

        if not v_tags:
            active_list = parsed_bullets
        elif len(matched_list) > 0:
            active_list = matched_list
        else:
            active_list = parsed_bullets
            is_fallback = True

        # Apply max_bullets cap
        capped_active = active_list[:max_bullets] if max_bullets is not None else active_list
        included_texts = {p[0] for p in capped_active}

        job_bullet_statuses: List[BulletStatus] = []
        for text, tags, has_match in parsed_bullets:
            inc = text in included_texts
            if not v_tags:
                reason = "all_included" if inc else "dropped_max_cap"
            elif inc:
                reason = "fallback" if is_fallback else "tag_match"
            else:
                if (text, tags, has_match) in active_list:
                    reason = "dropped_max_cap"
                else:
                    reason = "dropped_tag"
            if inc:
                total_inc += 1
            job_bullet_statuses.append(BulletStatus(text=text, tags=tags, matched=has_match, included=inc, reason=reason))

        dates = f"{job.get('start', '')} - {job.get('end', '')}".strip(" -")
        tailored_jobs.append(TailoredJob(
            company=job.get("company", ""),
            role=job.get("role", ""),
            dates=dates,
            location=job.get("location", ""),
            bullets=job_bullet_statuses,
            is_fallback=is_fallback
        ))

    # Projects filtering
    tailored_projects: List[TailoredProject] = []
    raw_projects = data.get("projects", [])
    if not v_tags:
        shown_projects = raw_projects
        proj_fallback = False
    else:
        matched_proj = [p for p in raw_projects if any(t in v_tags for t in p.get("tags", []))]
        if matched_proj:
            shown_projects = matched_proj
            proj_fallback = False
        else:
            shown_projects = raw_projects
            proj_fallback = True

    for proj in shown_projects:
        proj_tags = proj.get("tags", [])
        proj_matched = any(t in v_tags for t in proj_tags) if v_tags else True
        raw_b = proj.get("bullets", [])
        total_avail += len(raw_b)

        p_parsed: List[Tuple[str, List[str], bool]] = []
        for b in raw_b:
            if isinstance(b, dict):
                text = b.get("text", "")
                tags = b.get("tags", [])
            else:
                text = str(b)
                tags = []
            has_match = any(t in v_tags for t in tags) if v_tags else True
            p_parsed.append((text, tags, has_match))

        m_list = [p for p in p_parsed if p[2]]
        p_fallback = False
        if not v_tags:
            p_active = p_parsed
        elif len(m_list) > 0:
            p_active = m_list
        else:
            p_active = p_parsed
            p_fallback = True

        p_capped = p_active[:max_bullets] if max_bullets is not None else p_active
        p_inc_texts = {p[0] for p in p_capped}

        p_bullet_statuses: List[BulletStatus] = []
        for text, tags, has_match in p_parsed:
            inc = text in p_inc_texts
            if not v_tags:
                reason = "all_included" if inc else "dropped_max_cap"
            elif inc:
                reason = "fallback" if p_fallback else "tag_match"
            else:
                if (text, tags, has_match) in p_active:
                    reason = "dropped_max_cap"
                else:
                    reason = "dropped_tag"
            if inc:
                total_inc += 1
            p_bullet_statuses.append(BulletStatus(text=text, tags=tags, matched=has_match, included=inc, reason=reason))

        tailored_projects.append(TailoredProject(
            name=proj.get("name", ""),
            tech=proj.get("tech", ""),
            tags=proj_tags,
            is_entry_matched=proj_matched,
            bullets=p_bullet_statuses,
            is_fallback=p_fallback
        ))

    return TailoredResume(
        title=effective_title,
        title_overridden=title_overridden,
        summary=effective_summary,
        summary_overridden=summary_overridden,
        jobs=tailored_jobs,
        projects=tailored_projects,
        variant_tags=v_tags,
        max_bullets=max_bullets,
        total_bullets_included=total_inc,
        total_bullets_available=total_avail
    )


# ---------------------------------------------------------------------------
# Tag Analysis & Management
# ---------------------------------------------------------------------------

def extract_all_tags(data: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """
    Extracts all unique tags across jobs, bullets, and projects.
    Returns a dict mapping tag -> {'count': int, 'locations': List[str]}.
    """
    tag_info: Dict[str, Dict[str, Any]] = defaultdict(lambda: {"count": 0, "locations": []})

    for job in data.get("experience", []):
        company = job.get("company", "Unknown")
        role = job.get("role", "Unknown")
        loc_str = f"Job: {role} @ {company}"
        for b in job.get("bullets", []):
            if isinstance(b, dict):
                for t in b.get("tags", []):
                    tag_info[t]["count"] += 1
                    if loc_str not in tag_info[t]["locations"]:
                        tag_info[t]["locations"].append(loc_str)

    for proj in data.get("projects", []):
        name = proj.get("name", "Unknown")
        loc_str = f"Project: {name}"
        for t in proj.get("tags", []):
            tag_info[t]["count"] += 1
            if loc_str not in tag_info[t]["locations"]:
                tag_info[t]["locations"].append(loc_str)
        for b in proj.get("bullets", []):
            if isinstance(b, dict):
                for t in b.get("tags", []):
                    tag_info[t]["count"] += 1
                    if loc_str not in tag_info[t]["locations"]:
                        tag_info[t]["locations"].append(loc_str)

    return dict(sorted(tag_info.items(), key=lambda item: (-item[1]["count"], item[0])))

def get_untagged_bullets(data: Dict[str, Any]) -> List[Tuple[str, str]]:
    """Returns list of (location, bullet_text) for bullets with no tags."""
    untagged: List[Tuple[str, str]] = []
    for job in data.get("experience", []):
        loc = f"Job: {job.get('role')} @ {job.get('company')}"
        for b in job.get("bullets", []):
            if isinstance(b, dict):
                if not b.get("tags"):
                    untagged.append((loc, b.get("text", "")))
            else:
                untagged.append((loc, str(b)))

    for proj in data.get("projects", []):
        loc = f"Project: {proj.get('name')}"
        for b in proj.get("bullets", []):
            if isinstance(b, dict):
                if not b.get("tags"):
                    untagged.append((loc, b.get("text", "")))
            else:
                untagged.append((loc, str(b)))
    return untagged

def retag_globally(old_tag: str, new_tag: str, update_variants: bool = True) -> Tuple[int, int]:
    """
    Renames/merges old_tag into new_tag across data.json and all variants.
    Returns (data_replacement_count, variant_replacement_count).
    """
    data = load_data()
    data_count = 0

    def replace_in_tags(tags: List[str]) -> List[str]:
        nonlocal data_count
        res: List[str] = []
        for t in tags:
            if t == old_tag:
                data_count += 1
                if new_tag and new_tag not in res:
                    res.append(new_tag)
            else:
                if t not in res:
                    res.append(t)
        return res

    for job in data.get("experience", []):
        for b in job.get("bullets", []):
            if isinstance(b, dict) and "tags" in b:
                b["tags"] = replace_in_tags(b["tags"])

    for proj in data.get("projects", []):
        if "tags" in proj:
            proj["tags"] = replace_in_tags(proj["tags"])
        for b in proj.get("bullets", []):
            if isinstance(b, dict) and "tags" in b:
                b["tags"] = replace_in_tags(b["tags"])

    if data_count > 0:
        save_data(data)

    var_count = 0
    if update_variants and VARIANTS_DIR.exists():
        for vf in VARIANTS_DIR.glob("*.json"):
            try:
                with open(vf, "r", encoding="utf-8") as f:
                    vdata = json.load(f)
                vtags = vdata.get("tags", [])
                if old_tag in vtags:
                    new_vtags = []
                    for t in vtags:
                        if t == old_tag:
                            var_count += 1
                            if new_tag and new_tag not in new_vtags:
                                new_vtags.append(new_tag)
                        else:
                            if t not in new_vtags:
                                new_vtags.append(t)
                    vdata["tags"] = new_vtags
                    save_variant(vf.stem, vdata)
            except Exception as e:
                print_warning(f"Failed to check variant {vf.name}: {e}")

    return data_count, var_count


# ---------------------------------------------------------------------------
# Job Description Keyword Matcher
# ---------------------------------------------------------------------------

def match_job_description(text: str, data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Analyzes job description text against master data:
    - Finds matched tags from bullets/projects
    - Finds matched skills from skills section
    - Identifies top candidate title in the posting
    """
    known_tags = extract_all_tags(data)
    clean_text = " " + re.sub(r"[^a-zA-Z0-9_\-\.\+#/]", " ", text.lower()) + " "

    matched_tags: List[Tuple[str, int, int]] = []  # (tag, occurrences_in_job, bullets_in_resume)
    for tag, info in known_tags.items():
        pattern = r"(?:\b|\s)" + re.escape(tag.lower()) + r"(?:\b|\s)"
        matches = len(re.findall(pattern, clean_text))
        # Also check hyphenated variants (e.g. "open source" for "open-source")
        if "-" in tag and matches == 0:
            space_tag = tag.replace("-", " ")
            pattern_space = r"(?:\b|\s)" + re.escape(space_tag.lower()) + r"(?:\b|\s)"
            matches = len(re.findall(pattern_space, clean_text))

        if matches > 0:
            matched_tags.append((tag, matches, info["count"]))

    # Sort matched tags by occurrences in job, then by frequency in resume
    matched_tags.sort(key=lambda x: (-x[1], -x[2]))

    # Check skills matches
    skills_matched: Dict[str, List[str]] = defaultdict(list)
    for cat in data.get("skills", []):
        cat_name = cat.get("category", "General")
        for item in cat.get("items", []):
            item_clean = item.lower()
            pattern = r"(?:\b|\s)" + re.escape(item_clean) + r"(?:\b|\s)"
            if re.search(pattern, clean_text):
                skills_matched[cat_name].append(item)

    # Suggest a candidate title if found in the text
    title_match = None
    common_roles = [
        "Senior Backend Engineer", "Backend Engineer", "Software Engineer",
        "Senior Software Engineer", "Staff Software Engineer", "Full Stack Engineer",
        "Infrastructure Engineer", "DevOps Engineer", "Site Reliability Engineer",
        "Platform Engineer", "Lead Software Engineer", "Engineering Manager"
    ]
    for role in common_roles:
        if role.lower() in text.lower():
            title_match = role
            break

    return {
        "matched_tags": matched_tags,
        "matched_skills": dict(skills_matched),
        "suggested_title": title_match,
        "all_known_tags_count": len(known_tags),
    }


# ---------------------------------------------------------------------------
# Typst Compilation Runner
# ---------------------------------------------------------------------------

def run_typst(
    variant_name: Optional[str] = None,
    output_path: Optional[str] = None,
    data_path: Path = DATA_FILE,
    watch: bool = False,
) -> bool:
    """
    Executes 'typst compile' or 'typst watch' with the appropriate inputs.
    """
    if not shutil.which("typst"):
        print_error("Typst executable not found in PATH! Please install Typst to compile PDFs.")
        return False

    cmd = ["typst", "watch" if watch else "compile", str(TYPST_FILE)]

    if output_path:
        out_file = Path(output_path)
    elif variant_name:
        clean = variant_name.replace(".json", "")
        DIST_DIR.mkdir(parents=True, exist_ok=True)
        out_file = DIST_DIR / f"resume-{clean}.pdf"
    else:
        out_file = BASE_DIR / "resume.pdf"

    cmd.append(str(out_file))

    # Add Typst inputs (must be relative to BASE_DIR for Typst's root sandbox)
    try:
        data_rel = os.path.relpath(data_path, BASE_DIR)
    except ValueError:
        data_rel = str(data_path)
    cmd.extend(["--input", f"data={data_rel}"])

    if variant_name:
        clean = variant_name.replace(".json", "")
        variant_file = VARIANTS_DIR / f"{clean}.json"
        if not variant_file.exists():
            print_error(f"Variant file not found: {variant_file}")
            return False
        try:
            var_rel = os.path.relpath(variant_file, BASE_DIR)
        except ValueError:
            var_rel = str(variant_file)
        cmd.extend(["--input", f"variant={var_rel}"])

    print_info(f"Running: {' '.join(cmd)}")
    try:
        if watch:
            print_info("Starting Typst in watch mode. Press Ctrl+C to stop.")
            subprocess.run(cmd, cwd=BASE_DIR, check=True)
            return True
        else:
            proc = subprocess.run(cmd, cwd=BASE_DIR, capture_output=True, text=True, check=False)
            if proc.returncode == 0:
                size_kb = out_file.stat().st_size / 1024 if out_file.exists() else 0
                print_success(f"Successfully generated: {out_file.relative_to(BASE_DIR) if out_file.is_relative_to(BASE_DIR) else out_file} ({size_kb:.1f} KB)")
                # Print non-fatal font warnings if any, in dim styling
                if proc.stderr:
                    for line in proc.stderr.strip().splitlines():
                        if "warning: unknown font" in line.lower():
                            continue  # Expected font chain warnings
                        print(f"{Style.DIM}{line}{Style.RESET}")
                return True
            else:
                print_error(f"Typst compilation failed (exit code {proc.returncode}):")
                print(proc.stderr)
                return False
    except KeyboardInterrupt:
        print("\nStopped.")
        return True
    except Exception as e:
        print_error(f"Error executing Typst: {e}")
        return False


# ---------------------------------------------------------------------------
# Validation Engine
# ---------------------------------------------------------------------------

def validate_master_data(data: Dict[str, Any]) -> Tuple[List[str], List[str]]:
    """
    Validates data.json schema and data integrity.
    Returns (errors, warnings).
    """
    errors: List[str] = []
    warnings: List[str] = []

    # Required top-level keys
    for req in ["name", "title", "contact", "summary", "experience"]:
        if req not in data or not data[req]:
            errors.append(f"Missing or empty required top-level field: '{req}'")

    contact = data.get("contact", {})
    if not isinstance(contact, dict):
        errors.append("'contact' must be a dictionary")
    else:
        for f in ["email", "phone", "location"]:
            if f not in contact or not contact[f]:
                warnings.append(f"Contact missing recommended field: '{f}'")
        if "email" in contact and "@" not in contact["email"]:
            errors.append(f"Invalid email format: '{contact['email']}'")

    # Experience check
    experience = data.get("experience", [])
    if not isinstance(experience, list):
        errors.append("'experience' must be a list of jobs")
    else:
        for idx, job in enumerate(experience):
            c_name = job.get("company", f"Job #{idx+1}")
            for req in ["company", "role", "start", "end", "bullets"]:
                if req not in job or job[req] is None:
                    errors.append(f"Job '{c_name}' missing field: '{req}'")
            bullets = job.get("bullets", [])
            if not bullets:
                warnings.append(f"Job '{c_name}' has 0 bullets")
            for b_idx, b in enumerate(bullets):
                if isinstance(b, dict):
                    if not b.get("text"):
                        errors.append(f"Job '{c_name}' bullet #{b_idx+1} has empty text")
                    if "tags" not in b or not isinstance(b["tags"], list):
                        warnings.append(f"Job '{c_name}' bullet #{b_idx+1} missing 'tags' list")
                    elif len(b["tags"]) == 0:
                        warnings.append(f"Job '{c_name}' bullet #{b_idx+1} has empty tags [] (untagged)")
                elif isinstance(b, str):
                    warnings.append(f"Job '{c_name}' bullet #{b_idx+1} is a plain string without tags")
                else:
                    errors.append(f"Job '{c_name}' bullet #{b_idx+1} is not a valid bullet object")

    # Check variants tags against master tags
    known_tags = extract_all_tags(data)
    for vname in list_variants():
        _, vdata = load_variant(vname)
        for t in vdata.get("tags", []):
            if t not in known_tags:
                warnings.append(f"Variant '{vname}' references tag '{t}' which is not used in any bullet or project!")

    return errors, warnings


# ---------------------------------------------------------------------------
# CLI Action Implementations
# ---------------------------------------------------------------------------

def action_data_show() -> None:
    data = load_data()
    print_header("Master Resume Data Summary")
    print(f"{Style.BOLD}Name:{Style.RESET}        {data.get('name')}")
    print(f"{Style.BOLD}Title:{Style.RESET}       {data.get('title')}")
    c = data.get("contact", {})
    print(f"{Style.BOLD}Contact:{Style.RESET}     {c.get('email')} | {c.get('phone')} | {c.get('location')}")
    print(f"{Style.BOLD}Links:{Style.RESET}       github: {c.get('github')} | linkedin: {c.get('linkedin')} | website: {c.get('website')}")
    print(f"\n{Style.BOLD}Summary:{Style.RESET}\n  {data.get('summary')}\n")

    print(f"{Style.BOLD}Experience ({len(data.get('experience', []))} entries):{Style.RESET}")
    for j in data.get("experience", []):
        b_count = len(j.get("bullets", []))
        print(f"  • {Style.CYAN}{j.get('role')}{Style.RESET} @ {Style.BOLD}{j.get('company')}{Style.RESET} ({j.get('start')} - {j.get('end')}) — {b_count} bullets")

    print(f"\n{Style.BOLD}Projects ({len(data.get('projects', []))} entries):{Style.RESET}")
    for p in data.get("projects", []):
        print(f"  • {Style.CYAN}{p.get('name')}{Style.RESET} [{p.get('tech')}] (Tags: {', '.join(p.get('tags', []))})")

    print(f"\n{Style.BOLD}Skills Categories ({len(data.get('skills', []))}):{Style.RESET}")
    for s in data.get("skills", []):
        print(f"  • {Style.BOLD}{s.get('category')}:{Style.RESET} {', '.join(s.get('items', []))}")

    print(f"\n{Style.BOLD}Education:{Style.RESET}")
    for e in data.get("education", []):
        degree = e.get("degree")
        school = e.get("school", "")
        start = e.get("start")
        end = e.get("end")
        dates = f"{start} - {end}" if start and end else (end or start or "")
        title = f"{degree} - {school}" if degree and school else (degree or school)
        date_str = f" ({dates})" if dates else ""
        print(f"  • {title}{date_str}")

    print(f"\n{Style.BOLD}Certifications ({len(data.get('certifications', []))}):{Style.RESET}")
    for cert in data.get("certifications", []):
        print(f"  • {cert}")

def action_data_tags(detailed: bool = False) -> None:
    data = load_data()
    tag_info = extract_all_tags(data)
    print_header(f"Tag Explorer ({len(tag_info)} unique tags)")

    col_w = max(len(t) for t in tag_info.keys()) if tag_info else 10
    for tag, info in tag_info.items():
        bar = "█" * min(20, info["count"] * 2)
        print(f"  {Style.BOLD}{tag.ljust(col_w)}{Style.RESET}  {Style.CYAN}{info['count']:2d} bullets{Style.RESET}  {Style.DIM}{bar}{Style.RESET}")
        if detailed:
            for loc in info["locations"]:
                print(f"      ↳ {Style.DIM}{loc}{Style.RESET}")

    untagged = get_untagged_bullets(data)
    if untagged:
        print(f"\n{Style.YELLOW}Found {len(untagged)} untagged bullet(s):{Style.RESET}")
        for loc, text in untagged:
            print(f"  • [{loc}] {text[:70]}...")
    else:
        print(f"\n{Style.GREEN}✓ All bullets have at least one tag.{Style.RESET}")

def action_data_retag(old_tag: str, new_tag: str, update_variants: bool = True) -> None:
    print_header(f"Retag: '{old_tag}' → '{new_tag}'")
    d_count, v_count = retag_globally(old_tag, new_tag, update_variants)
    if d_count == 0 and v_count == 0:
        print_warning(f"Tag '{old_tag}' was not found in data.json or any variant.")
    else:
        print_success(f"Updated {d_count} bullet/project references in data.json")
        if update_variants:
            print_success(f"Updated {v_count} references across variants")

def action_data_validate() -> None:
    data = load_data()
    print_header("Validating Master Data & Variants")
    errors, warnings = validate_master_data(data)

    if errors:
        print(f"\n{Style.BOLD}{Style.RED}Errors ({len(errors)}):{Style.RESET}")
        for e in errors:
            print(f"  {Style.RED}✗ {e}{Style.RESET}")

    if warnings:
        print(f"\n{Style.BOLD}{Style.YELLOW}Warnings ({len(warnings)}):{Style.RESET}")
        for w in warnings:
            print(f"  {Style.YELLOW}⚠ {w}{Style.RESET}")

    if not errors and not warnings:
        print_success("data.json and all variants passed validation with zero errors or warnings!")
    elif not errors:
        print_success("data.json is valid (with minor warnings above).")

def action_data_format() -> None:
    data = load_data()
    save_data(data, make_backup=True)
    print_success(f"Formatted {DATA_FILE.name} and created backup {DATA_FILE.name}.bak")

def action_data_add_bullet() -> None:
    data = load_data()
    print_header("Add Bullet Point to Experience or Project")
    jobs = data.get("experience", [])
    projects = data.get("projects", [])

    print(f"\n{Style.BOLD}Select target:{Style.RESET}")
    idx = 1
    targets = []
    for j in jobs:
        print(f"  {idx}. [Job] {j.get('role')} @ {j.get('company')}")
        targets.append(("job", j))
        idx += 1
    for p in projects:
        print(f"  {idx}. [Project] {p.get('name')}")
        targets.append(("project", p))
        idx += 1

    choice = input(f"\nEnter choice (1-{len(targets)}): ").strip()
    try:
        target_type, target_obj = targets[int(choice) - 1]
    except (ValueError, IndexError):
        print_error("Invalid selection.")
        return

    text = input("Bullet text: ").strip()
    if not text:
        print_error("Bullet text cannot be empty.")
        return

    known_tags = list(extract_all_tags(data).keys())
    print(f"\n{Style.DIM}Available existing tags: {', '.join(known_tags[:15])}...{Style.RESET}")
    tags_input = input("Enter tags (comma-separated): ").strip()
    tags = [t.strip().lower() for t in tags_input.split(",") if t.strip()]

    new_bullet = {"text": text, "tags": tags}
    target_obj.setdefault("bullets", []).append(new_bullet)

    save_data(data)
    print_success(f"Added bullet with tags {tags} to {target_obj.get('company') or target_obj.get('name')}")

def action_data_add_job(
    company: Optional[str] = None,
    role: Optional[str] = None,
    location: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> None:
    data = load_data()
    print_header("Add New Experience (Job)")
    if not company:
        company = input("Company name: ").strip()
    if not role:
        role = input("Job title / role: ").strip()
    if not location:
        location = input("Location (e.g. Minneapolis, MN or Remote): ").strip()
    if not start:
        start = input("Start date (e.g. Jun 2022): ").strip()
    if not end:
        end = input("End date (e.g. Present): ").strip()

    if not company or not role or not start or not end:
        print_error("Company, role, start date, and end date are required.")
        return

    new_job = {
        "role": role,
        "company": company,
        "location": location,
        "start": start,
        "end": end,
        "bullets": []
    }

    if sys.stdin.isatty():
        print(f"\nEnter bullets for {role} @ {company} (leave blank to finish):")
        while True:
            b_text = input("  Bullet text: ").strip()
            if not b_text:
                break
            b_tags_str = input("  Tags (comma-separated): ").strip()
            b_tags = [t.strip().lower() for t in b_tags_str.split(",") if t.strip()]
            new_job["bullets"].append({"text": b_text, "tags": b_tags})

    pos = "top"
    if sys.stdin.isatty() and len(data.get("experience", [])) > 0:
        pos_in = input("Insert at top (most recent) or bottom? [Top/bottom]: ").strip().lower()
        if pos_in.startswith("b"):
            pos = "bottom"

    if pos == "top":
        data.setdefault("experience", []).insert(0, new_job)
    else:
        data.setdefault("experience", []).append(new_job)

    save_data(data)
    print_success(f"Added job: {role} @ {company} with {len(new_job['bullets'])} bullets")

def action_data_add_project(
    name: Optional[str] = None,
    tech: Optional[str] = None,
    tags: Optional[List[str]] = None,
) -> None:
    data = load_data()
    print_header("Add New Project")
    if not name:
        name = input("Project name: ").strip()
    if not tech:
        tech = input("Tech stack (e.g. Go, PostgreSQL, gRPC): ").strip()
    if tags is None and sys.stdin.isatty():
        tags_str = input("Project tags (comma-separated): ").strip()
        tags = [t.strip().lower() for t in tags_str.split(",") if t.strip()]

    if not name:
        print_error("Project name is required.")
        return

    new_proj = {
        "name": name,
        "tech": tech or "",
        "tags": tags or [],
        "bullets": []
    }

    if sys.stdin.isatty():
        print(f"\nEnter bullets for project '{name}' (leave blank to finish):")
        while True:
            b_text = input("  Bullet text: ").strip()
            if not b_text:
                break
            b_tags_str = input("  Tags (comma-separated): ").strip()
            b_tags = [t.strip().lower() for t in b_tags_str.split(",") if t.strip()]
            new_proj["bullets"].append({"text": b_text, "tags": b_tags})

    data.setdefault("projects", []).append(new_proj)
    save_data(data)
    print_success(f"Added project: {name} with {len(new_proj['bullets'])} bullets")

def action_data_add_skill(category: Optional[str] = None, item: Optional[str] = None) -> None:
    data = load_data()
    print_header("Add Skill")
    skills = data.get("skills", [])
    categories = [s.get("category") for s in skills]

    if not category and sys.stdin.isatty():
        print("Existing categories:")
        for i, c in enumerate(categories, 1):
            print(f"  {i}. {c}")
        print(f"  {len(categories)+1}. [New Category]")
        choice = input(f"Select category (1-{len(categories)+1}): ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(categories):
            category = categories[int(choice) - 1]
        else:
            category = input("Enter new category name: ").strip()

    if not category:
        print_error("Category name required.")
        return

    if not item:
        item = input(f"Skill name(s) to add to '{category}' (comma-separated): ").strip()

    items_to_add = [i.strip() for i in item.split(",") if i.strip()]
    if not items_to_add:
        print_error("No skill items provided.")
        return

    found = False
    for group in skills:
        if group.get("category", "").lower() == category.lower():
            for it in items_to_add:
                if it not in group.get("items", []):
                    group.setdefault("items", []).append(it)
            found = True
            break

    if not found:
        skills.append({"category": category, "items": items_to_add})

    save_data(data)
    print_success(f"Added skill(s) {items_to_add} to '{category}'")

def action_variant_edit(name: str) -> None:
    clean, vdata = load_variant(name)
    print_header(f"Edit Variant: '{clean}'")

    if not sys.stdin.isatty():
        action_edit_in_editor(VARIANTS_DIR / f"{clean}.json")
        return

    print(f"Current values:\n{json.dumps(vdata, indent=2)}\n")
    print("Choose edit mode:")
    print("  1. Interactive field editor")
    print("  2. Open in system text editor")
    choice = input("Choice [1/2]: ").strip()

    if choice == "2":
        action_edit_in_editor(VARIANTS_DIR / f"{clean}.json")
        return

    print("\nPress Enter to keep current value:")
    curr_title = vdata.get("title", "")
    new_title = input(f"Title override [{curr_title}]: ").strip()
    if new_title:
        vdata["title"] = new_title

    curr_sum = vdata.get("summary", "")
    new_sum = input(f"Summary override [{curr_sum[:40]}...]: ").strip()
    if new_sum:
        vdata["summary"] = new_sum

    curr_tags = ", ".join(vdata.get("tags", []))
    new_tags = input(f"Tags [{curr_tags}]: ").strip()
    if new_tags:
        vdata["tags"] = [t.strip().lower() for t in new_tags.split(",") if t.strip()]

    curr_cap = str(vdata.get("max_bullets_per_entry", "none"))
    new_cap = input(f"Max bullets per entry [{curr_cap}]: ").strip()
    if new_cap:
        if new_cap.lower() in ["none", "null", "unlimited", "0"]:
            vdata.pop("max_bullets_per_entry", None)
        elif new_cap.isdigit():
            vdata["max_bullets_per_entry"] = int(new_cap)

    save_variant(clean, vdata)
    print_success(f"Updated variant '{clean}'")

def action_variant_list() -> None:
    variants = list_variants()
    print_header(f"Resume Variants ({len(variants)})")
    if not variants:
        print("No variants found in variants/. Create one with 'resume.py variant create <name>'")
        return

    for vname in variants:
        _, vdata = load_variant(vname)
        tags = vdata.get("tags", [])
        max_b = vdata.get("max_bullets_per_entry")
        title = vdata.get("title", f"{Style.DIM}(default title){Style.RESET}")
        print(f"• {Style.BOLD}{Style.CYAN}{vname}{Style.RESET}")
        print(f"    Title override : {title}")
        print(f"    Tags ({len(tags)})     : {', '.join(tags) if tags else f'{Style.DIM}none (all bullets shown){Style.RESET}'}")
        print(f"    Max bullets    : {max_b if max_b is not None else 'unlimited'}")
        if "summary" in vdata:
            print(f"    Summary        : {vdata['summary'][:70]}...")
        print()

def action_variant_create(
    name: str,
    title: Optional[str] = None,
    summary: Optional[str] = None,
    tags: Optional[List[str]] = None,
    max_bullets: Optional[int] = None,
    from_job_file: Optional[str] = None,
) -> None:
    data = load_data()
    clean_name = re.sub(r"[^a-zA-Z0-9_\-]", "", name.lower().replace(" ", "-"))

    if from_job_file:
        job_path = Path(from_job_file)
        if not job_path.exists():
            print_error(f"Job posting file not found: {from_job_file}")
            return
        with open(job_path, "r", encoding="utf-8") as f:
            job_text = f.read()
        match_res = match_job_description(job_text, data)
        if not title and match_res.get("suggested_title"):
            title = match_res["suggested_title"]
        if not tags:
            tags = [t[0] for t in match_res["matched_tags"][:6]]
            print_info(f"Auto-selected tags from job posting: {', '.join(tags)}")

    variant_data: Dict[str, Any] = {}
    if title:
        variant_data["title"] = title
    if summary:
        variant_data["summary"] = summary
    variant_data["tags"] = tags if tags is not None else []
    if max_bullets is not None:
        variant_data["max_bullets_per_entry"] = max_bullets

    out_file = save_variant(clean_name, variant_data)
    print_success(f"Created variant '{clean_name}' at {out_file.relative_to(BASE_DIR)}")

def action_variant_delete(name: str) -> None:
    clean = name.replace(".json", "")
    target = VARIANTS_DIR / f"{clean}.json"
    if not target.exists():
        print_error(f"Variant '{clean}' not found.")
        return
    confirm = input(f"Are you sure you want to delete {target.name}? [y/N]: ").strip().lower()
    if confirm == "y":
        target.unlink()
        print_success(f"Deleted {target.name}")
    else:
        print("Cancelled.")

def action_variant_match(
    job_input: str,
    save_as: Optional[str] = None,
    title_override: Optional[str] = None,
    max_bullets: int = 3,
) -> None:
    """Matches text or a file path against known tags and skills."""
    data = load_data()
    candidate_path = Path(job_input)
    if candidate_path.exists() and candidate_path.is_file():
        with open(candidate_path, "r", encoding="utf-8") as f:
            text = f.read()
        print_header(f"Matching Job Posting: {candidate_path.name}")
    else:
        text = job_input
        print_header("Matching Job Posting Text")

    res = match_job_description(text, data)
    matched_tags = res["matched_tags"]
    matched_skills = res["matched_skills"]
    suggested_title = res["suggested_title"]

    print(f"\n{Style.BOLD}Top Matching Tags Found in Job Description:{Style.RESET}")
    if not matched_tags:
        print_warning("No existing resume tags matched the job posting text.")
    else:
        for tag, job_count, resume_count in matched_tags:
            print(f"  • {Style.GREEN}{Style.BOLD}{tag:<20}{Style.RESET} (mentioned in job: {job_count}x | resume bullets: {resume_count})")

    print(f"\n{Style.BOLD}Matching Skills Listed in Resume:{Style.RESET}")
    if not matched_skills:
        print("  None detected.")
    else:
        for cat, items in matched_skills.items():
            print(f"  • {Style.BOLD}{cat}:{Style.RESET} {', '.join(items)}")

    if suggested_title:
        print(f"\n{Style.BOLD}Suggested Title Override:{Style.RESET} {Style.CYAN}{suggested_title}{Style.RESET}")

    if matched_tags:
        rec_tags = [t[0] for t in matched_tags[:6]]
        print(f"\n{Style.BOLD}Recommended tags for variant:{Style.RESET} {Style.CYAN}{', '.join(rec_tags)}{Style.RESET}")

        if save_as:
            v_title = title_override or suggested_title
            action_variant_create(save_as, title=v_title, tags=rec_tags, max_bullets=max_bullets)
        elif sys.stdin.isatty():
            create_prompt = input("\nWould you like to create a new variant with these tags? [y/N]: ").strip().lower()
            if create_prompt == "y":
                v_name = input("Variant name (e.g. company-role): ").strip()
                if v_name:
                    custom_title = input(f"Title override (Enter for '{suggested_title or data.get('title')}'): ").strip()
                    v_title = custom_title if custom_title else suggested_title
                    max_b_str = input("Max bullets per entry (default 3): ").strip()
                    max_b = int(max_b_str) if max_b_str.isdigit() else 3
                    action_variant_create(v_name, title=v_title, tags=rec_tags, max_bullets=max_b)

def action_preview(variant_name: Optional[str] = None) -> None:
    data = load_data()
    vdata = None
    vname_str = "Base Resume (Untailored)"

    if variant_name:
        clean, vdata = load_variant(variant_name)
        vname_str = f"Variant: '{clean}'"

    tailored = simulate_variant(data, vdata)
    print_header(f"Tailored Resume Preview — {vname_str}")

    print(f"{Style.BOLD}Effective Title:{Style.RESET} {tailored.title}" +
          (f" {Style.MAGENTA}[OVERRIDDEN]{Style.RESET}" if tailored.title_overridden else ""))
    print(f"{Style.BOLD}Variant Tags:{Style.RESET}    {', '.join(tailored.variant_tags) if tailored.variant_tags else f'{Style.DIM}(none - all bullets shown){Style.RESET}'}")
    print(f"{Style.BOLD}Max Bullets:{Style.RESET}     {tailored.max_bullets if tailored.max_bullets is not None else 'None (uncapped)'}")

    if tailored.summary:
        print(f"\n{Style.BOLD}Summary:{Style.RESET}" + (f" {Style.MAGENTA}[OVERRIDDEN]{Style.RESET}" if tailored.summary_overridden else ""))
        print(f"  {tailored.summary}")

    print(f"\n{Style.BOLD}Experience:{Style.RESET}")
    for job in tailored.jobs:
        fallback_flag = f" {Style.YELLOW}[FALLBACK: 0 tag matches, showing all]{Style.RESET}" if job.is_fallback else ""
        print(f"\n  • {Style.BOLD}{job.role}{Style.RESET} @ {Style.CYAN}{job.company}{Style.RESET} ({job.dates}){fallback_flag}")
        for b in job.bullets:
            tags_str = f" [{', '.join(b.tags)}]" if b.tags else ""
            if b.included:
                print(f"      {Style.GREEN}✔ - {b.text}{Style.RESET}{Style.DIM}{tags_str}{Style.RESET}")
            else:
                reason_str = "exceeded max cap" if b.reason == "dropped_max_cap" else "tag mismatch"
                print(f"      {Style.DIM}✘ - (dropped: {reason_str}) {b.text[:65]}...{tags_str}{Style.RESET}")

    if tailored.projects:
        print(f"\n{Style.BOLD}Projects:{Style.RESET}")
        for p in tailored.projects:
            match_flag = f" {Style.GREEN}[MATCHED]{Style.RESET}" if p.is_entry_matched else f" {Style.DIM}[UNMATCHED]{Style.RESET}"
            print(f"\n  • {Style.BOLD}{p.name}{Style.RESET} ({p.tech}){match_flag}")
            for b in p.bullets:
                tags_str = f" [{', '.join(b.tags)}]" if b.tags else ""
                if b.included:
                    print(f"      {Style.GREEN}✔ - {b.text}{Style.RESET}{Style.DIM}{tags_str}{Style.RESET}")
                else:
                    print(f"      {Style.DIM}✘ - (dropped) {b.text[:65]}...{tags_str}{Style.RESET}")

    print(f"\n{Style.BOLD}Total Bullets Shown:{Style.RESET} {tailored.total_bullets_included} of {tailored.total_bullets_available} available ({tailored.total_bullets_included / max(1, tailored.total_bullets_available) * 100:.0f}%)")

def action_build(
    variant_name: Optional[str] = None,
    output: Optional[str] = None,
    all_variants: bool = False,
    watch: bool = False,
) -> None:
    if all_variants:
        print_header("Building All Resume Variants")
        print(f"\n{Style.BOLD}1. Base Resume:{Style.RESET}")
        run_typst(output_path=str(BASE_DIR / "resume.pdf"))

        variants = list_variants()
        for idx, vname in enumerate(variants, start=2):
            print(f"\n{Style.BOLD}{idx}. Variant: {vname}{Style.RESET}")
            run_typst(variant_name=vname)
        print_success("Completed building all resumes!")
    else:
        run_typst(variant_name=variant_name, output_path=output, watch=watch)

def action_edit_in_editor(target_file: Path) -> None:
    """Opens a file in the user's preferred editor ($EDITOR or nvim/vim/nano)."""
    editor = os.environ.get("EDITOR")
    if not editor:
        for candidate in ["nvim", "vim", "nano", "vi"]:
            if shutil.which(candidate):
                editor = candidate
                break

    if not editor:
        print_error("No text editor found in environment. Set $EDITOR or install vim/nano.")
        return

    create_backup(target_file)
    print_info(f"Opening {target_file.name} in {editor} (backup created)...")
    subprocess.run([editor, str(target_file)])

    if target_file.suffix == ".json":
        try:
            with open(target_file, "r", encoding="utf-8") as f:
                json.load(f)
            print_success(f"JSON in {target_file.name} is valid.")
        except json.JSONDecodeError as e:
            print_error(f"Syntax error in modified {target_file.name}: {e}")
            restore = input("Restore from backup? [Y/n]: ").strip().lower()
            if restore != "n":
                shutil.copy2(target_file.with_suffix(target_file.suffix + ".bak"), target_file)
                print_info("Restored from backup.")


# ---------------------------------------------------------------------------
# Interactive Wizard
# ---------------------------------------------------------------------------

def _ask_yes_no(prompt: str) -> bool:
    """Yes/no prompt; defaults to no."""
    return input(f"{prompt} [y/N]: ").strip().lower() in ("y", "yes")

def _prompt_common_bullets(owner_label: str) -> List[Dict[str, Any]]:
    """Collects bullet objects (text + tags) for a job or project."""
    bullets: List[Dict[str, Any]] = []
    print(f"  Bullets for {owner_label} (leave text blank to finish):")
    while True:
        b_text = input("    Bullet text: ").strip()
        if not b_text:
            break
        b_tags = [t.strip().lower() for t in input("    Tags (comma-separated): ").strip().split(",") if t.strip()]
        bullets.append({"text": b_text, "tags": b_tags})
    return bullets

def _prompt_job() -> Dict[str, Any]:
    """Prompts for a single experience entry."""
    print(f"\n{Style.BOLD}-- New Experience --{Style.RESET}")
    role = input("  Role / Title: ").strip()
    company = input("  Company: ").strip()
    location = input("  Location (optional): ").strip()
    start = input("  Start (e.g. Jun 2022): ").strip()
    end = input("  End (e.g. Present): ").strip()
    bullets = _prompt_common_bullets(f"{role} @ {company}")
    return {"role": role, "company": company, "location": location, "start": start, "end": end, "bullets": bullets}

def _prompt_project() -> Dict[str, Any]:
    """Prompts for a single project entry."""
    print(f"\n{Style.BOLD}-- New Project --{Style.RESET}")
    name = input("  Project name: ").strip()
    tech = input("  Tech stack (e.g. Go, PostgreSQL): ").strip()
    tags = [t.strip().lower() for t in input("  Project tags (comma-separated): ").strip().split(",") if t.strip()]
    bullets = _prompt_common_bullets(name)
    return {"name": name, "tech": tech, "tags": tags, "bullets": bullets}

def _prompt_education() -> Dict[str, Any]:
    """Prompts for a single education entry."""
    print(f"\n{Style.BOLD}-- New Education Entry --{Style.RESET}")
    school = input("  School / Institution: ").strip()
    degree = input("  Degree (optional): ").strip()
    location = input("  Location (optional): ").strip()
    start = input("  Start (optional): ").strip()
    end = input("  End (optional): ").strip()
    entry: Dict[str, Any] = {"school": school, "location": location, "start": start, "end": end}
    if degree:
        entry["degree"] = degree
    return entry

def create_new_data(overwrite: bool = False) -> Dict[str, Any]:
    """Guided wizard that creates a brand-new data.json from scratch."""
    print_header("Create New Resume Data File")
    print_info("I'll walk you through the basics, then let you add optional sections.")

    name = ""
    while not name:
        name = input("Full name (required): ").strip()
    title = ""
    while not title:
        title = input("Title (required, e.g. Software Engineer): ").strip()

    print(f"\n{Style.BOLD}Contact info (press Enter to skip each):{Style.RESET}")
    email = input("  Email: ").strip()
    phone = input("  Phone: ").strip()
    location = input("  Location (e.g. Minneapolis, MN): ").strip()
    linkedin = input("  LinkedIn URL: ").strip()
    github = input("  GitHub URL: ").strip()
    website = input("  Website URL: ").strip()

    summary = input(f"\n{Style.BOLD}Summary{Style.RESET} (2-3 sentence professional summary): ").strip()

    data: Dict[str, Any] = {
        "name": name,
        "title": title,
        "contact": {
            "email": email,
            "phone": phone,
            "location": location,
            "linkedin": linkedin,
            "github": github,
            "website": website,
        },
        "summary": summary,
        "experience": [],
        "education": [],
        "skills": [],
        "projects": [],
        "certifications": [],
    }

    print(f"\n{Style.BOLD}{Style.CYAN}Optional sections{Style.RESET} — add content now or edit it later.")

    if _ask_yes_no("Add experience (job) entries?"):
        while True:
            job = _prompt_job()
            if job.get("role") or job.get("company") or job["bullets"]:
                data["experience"].append(job)
            if not _ask_yes_no("Add another job?"):
                break

    if _ask_yes_no("Add projects?"):
        while True:
            proj = _prompt_project()
            if proj.get("name"):
                data["projects"].append(proj)
            if not _ask_yes_no("Add another project?"):
                break

    if _ask_yes_no("Add skills categories?"):
        while True:
            print(f"\n{Style.BOLD}-- New Skill Category --{Style.RESET}")
            category = input("  Category (e.g. Programming & Scripting): ").strip()
            items = [i.strip() for i in input("  Skills (comma-separated): ").strip().split(",") if i.strip()]
            if category or items:
                data["skills"].append({"category": category, "items": items})
            if not _ask_yes_no("Add another category?"):
                break

    if _ask_yes_no("Add education entries?"):
        while True:
            edu = _prompt_education()
            if edu.get("school"):
                data["education"].append(edu)
            if not _ask_yes_no("Add another education entry?"):
                break

    if _ask_yes_no("Add certifications?"):
        certs = input("  Certifications (comma-separated): ").strip()
        data["certifications"] = [c.strip() for c in certs.split(",") if c.strip()]

    if overwrite:
        backup = create_backup(DATA_FILE)
        if backup:
            print_info(f"Backed up existing file to {backup.name}.")

    save_data(data, make_backup=False)
    print_success(f"Created {DATA_FILE.name}.")

    errors, warnings = validate_master_data(data)
    if errors:
        print(f"\n{Style.YELLOW}The new file has a few items to fix later:{Style.RESET}")
        for e in errors:
            print(f"  ⚠ {e}")
    for w in warnings:
        print(f"  {Style.DIM}ℹ {w}{Style.RESET}")
    if not errors:
        print_success("The new data file passed basic validation. Edit or add content with 'python3 resume.py'.")
    return data

def ask_create_data_file() -> bool:
    """Called when data.json is missing: offers to run the creation wizard."""
    print_header("Data File Missing")
    print_warning(f"{DATA_FILE.name} was not found next to resume.py.")
    if not sys.stdin.isatty():
        print_error("Interactive creation requires a terminal (TTY).")
        print_info(f"Run 'python3 resume.py init' to create one.")
        return False
    if _ask_yes_no("Create a new resume data file now?"):
        create_new_data()
        return True
    print_info(f"No file created. Use 'python3 resume.py init' whenever you're ready.")
    return False

def interactive_menu() -> None:
    while True:
        print(f"\n{Style.BOLD}{Style.CYAN}╔════════════════════════════════════════════════════════════╗{Style.RESET}")
        print(f"{Style.BOLD}{Style.CYAN}║                Resume & CV Manager (Typst)                 ║{Style.RESET}")
        print(f"{Style.BOLD}{Style.CYAN}╚════════════════════════════════════════════════════════════╝{Style.RESET}")
        print("  1.  Preview resume (base or variant)")
        print("  2.  Build / compile PDF (base, variant, or all)")
        print("  3.  List & inspect variants")
        print("  4.  Create new variant (interactive or from job posting)")
        print("  5.  Edit an existing variant")
        print("  6.  Delete a variant")
        print("  7.  Match job description keywords against resume tags")
        print("  8.  Explore & manage tags (frequencies, untagged bullets)")
        print("  9.  Global retag / rename tags")
        print(" 10.  Add content (Job, Bullet, Project, Skill)")
        print(" 11.  Validate master data & variants")
        print(" 12.  Edit data.json in editor")
        print(" 13.  Create / recreate data.json from scratch")
        print("  0.  Exit")

        choice = input(f"\n{Style.BOLD}Select an option (0-13):{Style.RESET} ").strip()
        if choice == "0" or choice.lower() in ["q", "exit", "quit"]:
            print("Goodbye!")
            break
        elif choice == "1":
            variants = list_variants()
            print("\nAvailable variants:")
            print("  0. [Base Resume - Untailored]")
            for i, v in enumerate(variants, 1):
                print(f"  {i}. {v}")
            v_choice = input("Select variant to preview (0 for base): ").strip()
            if v_choice == "0":
                action_preview(None)
            elif v_choice.isdigit() and 1 <= int(v_choice) <= len(variants):
                action_preview(variants[int(v_choice) - 1])
            else:
                print_error("Invalid selection.")
        elif choice == "2":
            print("\nBuild Options:")
            print("  1. Build Base Resume (resume.pdf)")
            print("  2. Build a specific Variant")
            print("  3. Build ALL Resumes (Base + all variants into dist/)")
            b_choice = input("Select build option: ").strip()
            if b_choice == "1":
                action_build(None)
            elif b_choice == "2":
                variants = list_variants()
                for i, v in enumerate(variants, 1):
                    print(f"  {i}. {v}")
                v_choice = input("Select variant to build: ").strip()
                if v_choice.isdigit() and 1 <= int(v_choice) <= len(variants):
                    action_build(variant_name=variants[int(v_choice) - 1])
            elif b_choice == "3":
                action_build(all_variants=True)
        elif choice == "3":
            action_variant_list()
        elif choice == "4":
            name = input("\nEnter variant name (e.g. google-backend): ").strip()
            if not name:
                continue
            title = input("Target title override (leave blank to keep master title): ").strip()
            summary = input("Custom summary override (leave blank to keep master summary): ").strip()
            data = load_data()
            known = list(extract_all_tags(data).keys())
            print(f"{Style.DIM}Known tags: {', '.join(known)}{Style.RESET}")
            tags_str = input("Enter comma-separated tags: ").strip()
            tags = [t.strip().lower() for t in tags_str.split(",") if t.strip()]
            cap_str = input("Max bullets per entry (leave blank for unlimited, or e.g. 2 or 3): ").strip()
            max_b = int(cap_str) if cap_str.isdigit() else None
            action_variant_create(name, title=title or None, summary=summary or None, tags=tags, max_bullets=max_b)
        elif choice == "5":
            variants = list_variants()
            if not variants:
                print_warning("No variants exist to edit.")
                continue
            for i, v in enumerate(variants, 1):
                print(f"  {i}. {v}")
            v_choice = input("Select variant to edit: ").strip()
            if v_choice.isdigit() and 1 <= int(v_choice) <= len(variants):
                action_variant_edit(variants[int(v_choice) - 1])
        elif choice == "6":
            variants = list_variants()
            if not variants:
                print_warning("No variants exist.")
                continue
            for i, v in enumerate(variants, 1):
                print(f"  {i}. {v}")
            v_choice = input("Select variant to delete: ").strip()
            if v_choice.isdigit() and 1 <= int(v_choice) <= len(variants):
                action_variant_delete(variants[int(v_choice) - 1])
        elif choice == "7":
            print("\nPaste a job posting text, or enter the path to a file containing it:")
            source = input("File path or text: ").strip()
            if source:
                action_variant_match(source)
        elif choice == "8":
            action_data_tags(detailed=True)
        elif choice == "9":
            old_t = input("Tag to rename/replace: ").strip()
            new_t = input("New tag name: ").strip()
            if old_t and new_t:
                action_data_retag(old_t, new_t)
        elif choice == "10":
            print("\nAdd content:")
            print("  1. Add bullet point to job or project")
            print("  2. Add new job experience")
            print("  3. Add new project")
            print("  4. Add skill")
            c_sub = input("Select (1-4): ").strip()
            if c_sub == "1":
                action_data_add_bullet()
            elif c_sub == "2":
                action_data_add_job()
            elif c_sub == "3":
                action_data_add_project()
            elif c_sub == "4":
                action_data_add_skill()
        elif choice == "11":
            action_data_validate()
        elif choice == "12":
            action_edit_in_editor(DATA_FILE)
        elif choice == "13":
            if DATA_FILE.exists() and not _ask_yes_no("Overwrite current data.json?"):
                continue
            create_new_data(overwrite=True)


# ---------------------------------------------------------------------------
# Argument Parser Definition
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="resume.py",
        description="Resume & CV Manager for Typst: data editing, variant tailoring, tag exploration, and PDF builds.",
    )
    subparsers = parser.add_subparsers(dest="command", help="Subcommand to execute")

    # interactive
    subparsers.add_parser("interactive", aliases=["ui", "i"], help="Launch interactive wizard/menu")

    # init / setup
    subparsers.add_parser(
        "init", aliases=["setup"], help="Create a new data.json from scratch (guided wizard)"
    )

    # preview
    p_preview = subparsers.add_parser("preview", help="Preview tailored resume text in terminal")
    p_preview.add_argument("variant", nargs="?", default=None, help="Name of variant to preview (omit for base resume)")

    # build
    p_build = subparsers.add_parser("build", aliases=["compile"], help="Compile PDF with Typst")
    p_build.add_argument("--variant", "-v", default=None, help="Variant name to build")
    p_build.add_argument("--output", "-o", default=None, help="Custom output PDF path")
    p_build.add_argument("--all", "-a", action="store_true", help="Build base and all variants")
    p_build.add_argument("--watch", "-w", action="store_true", help="Run Typst in watch mode")

    # variant
    p_var = subparsers.add_parser("variant", help="Variant operations")
    var_subs = p_var.add_subparsers(dest="var_command", help="Variant action")

    var_subs.add_parser("list", aliases=["ls"], help="List all variants")

    p_var_show = var_subs.add_parser("show", help="Show variant details")
    p_var_show.add_argument("name", help="Variant name")

    p_var_create = var_subs.add_parser("create", aliases=["new", "add"], help="Create a new variant")
    p_var_create.add_argument("name", help="Variant name (e.g. backend-lead)")
    p_var_create.add_argument("--title", help="Target title override")
    p_var_create.add_argument("--summary", help="Custom summary override")
    p_var_create.add_argument("--tags", "-t", help="Comma-separated tags")
    p_var_create.add_argument("--max-bullets", "-m", type=int, help="Max bullets per job/project")
    p_var_create.add_argument("--from-job", help="Path to job posting file to auto-extract tags")

    p_var_edit = var_subs.add_parser("edit", help="Edit an existing variant")
    p_var_edit.add_argument("name", help="Variant name to edit")

    p_var_del = var_subs.add_parser("delete", aliases=["rm"], help="Delete a variant")
    p_var_del.add_argument("name", help="Variant name to delete")

    p_var_match = var_subs.add_parser("match", help="Match a job posting against resume tags")
    p_var_match.add_argument("job", help="Job posting text or path to text file")
    p_var_match.add_argument("--save", "-s", help="Automatically create variant with matched tags and given name")
    p_var_match.add_argument("--title", help="Target title override for created variant")
    p_var_match.add_argument("--max-bullets", "-m", type=int, default=3, help="Max bullets per job for created variant")

    p_var_prev = var_subs.add_parser("preview", help="Preview a specific variant")
    p_var_prev.add_argument("name", help="Variant name to preview")

    # data
    p_data = subparsers.add_parser("data", help="Master data operations (data.json)")
    data_subs = p_data.add_subparsers(dest="data_command", help="Data action")

    data_subs.add_parser("show", help="Show summary of master resume data")
    data_subs.add_parser("validate", aliases=["check"], help="Validate data.json structure & tags")
    data_subs.add_parser("format", help="Reformat data.json with standard indentation")

    p_tags = data_subs.add_parser("tags", help="Explore tags and frequencies")
    p_tags.add_argument("--detailed", "-d", action="store_true", help="Show bullet locations for each tag")

    p_retag = data_subs.add_parser("retag", help="Globally rename or merge a tag")
    p_retag.add_argument("old_tag", help="Old tag name to replace")
    p_retag.add_argument("new_tag", help="New tag name")
    p_retag.add_argument("--no-variants", action="store_true", help="Do not update variants, only data.json")

    data_subs.add_parser("add-bullet", help="Interactively add a bullet to a job or project")
    data_subs.add_parser("add-job", help="Add a new experience entry (job)")
    data_subs.add_parser("add-project", help="Add a new project")
    data_subs.add_parser("add-skill", help="Add a skill or category")
    data_subs.add_parser("edit", help="Open data.json in system text editor")

    args = parser.parse_args()

    # Explicit init/setup: create a fresh data.json (backing up any existing file).
    if args.command in ["init", "setup"]:
        if DATA_FILE.exists():
            print_warning(f"{DATA_FILE.name} already exists.")
            if _ask_yes_no("Overwrite it with a fresh resume file? (existing file will be backed up)"):
                create_new_data(overwrite=True)
            else:
                print_info("Canceled. Nothing was changed.")
        else:
            create_new_data()
        return

    # If the master data file is missing, offer to create it before routing
    # to any command that needs it.
    if not DATA_FILE.exists():
        if ask_create_data_file():
            pass
        else:
            sys.exit(1)

    # Route commands
    if args.command in ["interactive", "ui", "i"] or (len(sys.argv) == 1 and sys.stdin.isatty()):
        interactive_menu()
    elif args.command == "preview":
        action_preview(args.variant)
    elif args.command in ["build", "compile"]:
        action_build(variant_name=args.variant, output=args.output, all_variants=args.all, watch=args.watch)
    elif args.command == "variant":
        if args.var_command in ["list", "ls"]:
            action_variant_list()
        elif args.var_command == "show":
            _, vdata = load_variant(args.name)
            print(json.dumps(vdata, indent=2))
        elif args.var_command in ["create", "new", "add"]:
            tags_list = [t.strip() for t in args.tags.split(",") if t.strip()] if args.tags else None
            action_variant_create(args.name, title=args.title, summary=args.summary, tags=tags_list, max_bullets=args.max_bullets, from_job_file=args.from_job)
        elif args.var_command == "edit":
            action_variant_edit(args.name)
        elif args.var_command in ["delete", "rm"]:
            action_variant_delete(args.name)
        elif args.var_command == "match":
            action_variant_match(args.job, save_as=args.save, title_override=args.title, max_bullets=args.max_bullets)
        elif args.var_command == "preview":
            action_preview(args.name)
        else:
            p_var.print_help()
    elif args.command == "data":
        if args.data_command == "show":
            action_data_show()
        elif args.data_command in ["validate", "check"]:
            action_data_validate()
        elif args.data_command == "format":
            action_data_format()
        elif args.data_command == "tags":
            action_data_tags(detailed=args.detailed)
        elif args.data_command == "retag":
            action_data_retag(args.old_tag, args.new_tag, update_variants=not args.no_variants)
        elif args.data_command == "add-bullet":
            action_data_add_bullet()
        elif args.data_command == "add-job":
            action_data_add_job()
        elif args.data_command == "add-project":
            action_data_add_project()
        elif args.data_command == "add-skill":
            action_data_add_skill()
        elif args.data_command == "edit":
            action_edit_in_editor(DATA_FILE)
        else:
            p_data.print_help()
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
