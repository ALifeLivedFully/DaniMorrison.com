// ============================================================
// ATS & AI-friendly resume template
// ------------------------------------------------------------
// Design principles, based on standard ATS guidance (see e.g.
// University at Buffalo's Career Resource Center ATS résumé
// guide) plus empirical testing against real text-extraction
// tools (poppler's pdftotext, in both its default and -layout
// modes -- a reasonable proxy for how many ATS parsers work):
//
//  - Single column, no tables/grids anywhere on the page.
//  - Right-aligned dates use a "tab stop" (a single flowing
//    line with one flexible space), never a table. Verified
//    this preserves correct reading order under layout-aware
//    extraction; a true table risks scrambled or dropped cells.
//  - Company/location and job title are split onto two lines
//    rather than crammed onto one with the dates -- the ATS
//    guide notes this is "possible, but not ideal."
//  - Plain, unstyled hyphens for bullets and date ranges (no
//    en/em dashes), matching the guide's listed acceptable
//    date formats and its "standard symbols, not fancy ones"
//    rule for bullets.
//  - Full URLs including https:// for LinkedIn/GitHub/website,
//    since a bare "linkedin.com/..." string without a protocol
//    prefix isn't reliably recognized as a link by ATS software.
//  - Standard section headings (Summary, Experience, Projects,
//    Education, Skills, Certifications), each its own section --
//    certifications in particular should never be folded into
//    Skills, since ATS systems commonly score that heading on
//    its own.
//  - Generic, widely-installed font (Arial primary, with safe
//    fallbacks), 10-14pt range.
//  - No headers, footers, page numbers, images, icons, or text
//    color used as the only way to convey information.
//  - Content lives entirely in data.json; resume.typ is pure
//    layout/template logic.
//
// ---------- Tailoring system ----------
// data.json is the MASTER file: every bullet you've ever written, each
// tagged with keywords (see the "tags" array on each bullet/project).
// A "variant" file lets you tailor the resume per application without
// duplicating the whole document. A variant is a small JSON file like:
//
//   {
//     "title": "Senior Backend Engineer",       // optional, overrides data.json
//     "summary": "Custom summary for this role", // optional, overrides data.json
//     "tags": ["backend", "kubernetes", "leadership"],
//     "max_bullets_per_entry": 3                 // optional cap
//   }
//
// Bullets/projects matching ANY listed tag are kept; everything else for
// that job/project is dropped. If a job or project has NO bullets matching
// the variant's tags, ALL of its bullets are shown instead (a safe default
// so tailoring can never silently blank out an entire job). If no variant
// is supplied, every bullet is shown, in full -- identical to before this
// system existed.
//
// Usage:
//   typst compile resume.typ resume.pdf
//   typst compile resume.typ resume.pdf --input data=data.json --input variant=variants/backend.json
// ============================================================

#let data-path = sys.inputs.at("data", default: "data.json")
#let variant-path = sys.inputs.at("variant", default: "")

#let data = json(data-path)
#let variant = if variant-path != "" { json(variant-path) } else { (:) }
#let v-tags = variant.at("tags", default: ())
#let max-bullets = variant.at("max_bullets_per_entry", default: none)

// Given a list of bullets (each either a plain string, or a dict with
// "text" and "tags" keys), return the plain display strings after applying
// the variant's tag filter. Falls back to showing everything if the
// variant has no tags, or if nothing in this particular list matches.
#let filter-bullets(items) = {
  if items == none { return () }
  let as-text(it) = if type(it) == dictionary { it.text } else { it }
  if v-tags.len() == 0 {
    return items.map(as-text)
  }
  let matched = items.filter(it => {
    if type(it) == dictionary {
      it.at("tags", default: ()).any(t => t in v-tags)
    } else {
      false // untagged plain-string bullets can't match a tag filter
    }
  })
  let result = if matched.len() > 0 { matched } else { items }
  let texts = result.map(as-text)
  if max-bullets != none and texts.len() > max-bullets {
    texts = texts.slice(0, max-bullets)
  }
  texts
}

// For whole entries (currently used for projects) that carry their own
// top-level "tags": keep it if the variant filter matches, or if there's
// no variant filter at all. If NOTHING in the list matches, fall back to
// keeping everything (same safe-default philosophy as filter-bullets).
#let filter-entries(entries) = {
  if v-tags.len() == 0 { return entries }
  let matched = entries.filter(e => e.at("tags", default: ()).any(t => t in v-tags))
  if matched.len() > 0 { matched } else { entries }
}

// ---------- Page & text setup ----------
#set document(title: data.name, author: data.name)
#set page(
  paper: "us-letter",
  margin: (top: 0.55in, bottom: 0.55in, left: 0.65in, right: 0.65in),
)
#set text(
  // Arial/Calibri/Helvetica are tried first since many systems (Windows,
  // macOS, and this sandbox) have them installed, and they match the ATS
  // guide's explicit recommendation. On systems without them (e.g. a bare
  // Linux/NixOS install), Typst will print "unknown font family" warnings
  // for those three -- that's expected and harmless, NOT a bug: it just
  // means Typst is skipping straight to the final fallback below.
  // "Libertinus Serif" is the one font guaranteed to ship with every Typst
  // install (verified via typst's embedded-font list), so the chain always
  // resolves to something -- it's visually close to Times New Roman, which
  // the ATS guide also explicitly lists as an acceptable font.
  font: ("Arial", "Calibri", "Helvetica", "Libertinus Serif"),
  size: 10pt,
  lang: "en",
  fill: rgb("#1a1a1a"),
)
#set par(justify: false, leading: 0.55em)
#set block(spacing: 0.65em)

// A single accent color, used sparingly (safe to print in B/W too)
#let accent = rgb("#1f3a5f")

// ---------- Reusable components ----------

// Section heading: plain text label + thin rule, always real text.
#let section(title) = {
  block(above: 2.3em, below: 0.5em)[
    #text(size: 11.5pt, weight: "bold", fill: accent, tracking: 0.5pt)[
      #upper(title)
    ]
    #v(-0.55em)
    #line(length: 100%, stroke: 0.6pt + accent)
  ]
}

// Right-aligned "tab stop" line: one continuous line of text with a single
// flexible space pushing the right-hand content (typically a date range) to
// the margin. This is NOT a table or grid -- it's one paragraph, so reading
// order in extracted text stays correct. Verified against pdftotext -layout.
#let tab-line(left, right) = {
  block(above: 0pt, below: 0.25em)[
    #left #h(1fr) #right
  ]
}

// Bullet list with a plain, standard hyphen marker (not an en/em dash).
#let bullets(items) = {
  if items != none and items.len() > 0 {
    list(
      marker: [-],
      spacing: 0.35em,
      indent: 0pt,
      body-indent: 0.6em,
      ..items.map(it => text(size: 9.7pt)[#it])
    )
  }
}

// One work/education/project entry: company+location right-aligned with
// dates on the first line, job title on its own line below (per ATS
// guidance -- cramming company, title, location, and dates onto a single
// line is "possible, but not ideal"), then bullets.
#let entry(heading, subheading, dates, items) = {
  tab-line(
    text(weight: "bold", size: 10.3pt)[#heading],
    text(size: 9.5pt)[#dates],
  )
  if subheading != none and subheading != "" {
    block(above: 0pt, below: 0.3em)[
      #text(style: "italic", size: 9.7pt)[#subheading]
    ]
  }
  bullets(items)
}

// ---------- Header ----------
// Name and contact info come first, at the very top, never in a page
// header/footer (ATS software frequently ignores true header/footer
// regions of a PDF).
#let effective-title = variant.at("title", default: data.at("title", default: none))
#align(center)[
  #text(size: 20pt, weight: "bold")[#data.name]
  #if effective-title != none and effective-title != "" [
    #v(0.15em)
    #text(size: 11.5pt, fill: accent)[#effective-title]
  ]
]

#v(0.4em)

// Full URLs (with https://) so links are recognized as such by ATS
// parsers, which generally require the protocol or "www." prefix to be
// present in the visible text -- not just embedded as a hyperlink target.
#let c = data.contact
#let line1 = {
  let parts = ()
  if "location" in c and c.location != "" { parts.push([#c.location]) }
  if "phone" in c and c.phone != "" {
    let digits = c.phone.replace(regex("[^0-9]"), "")
    let tel-href = if digits.len() == 10 { "tel:+1" + digits } else { "tel:" + digits }
    parts.push(link(tel-href)[#c.phone])
  }
  if "email" in c and c.email != "" { parts.push(link("mailto:" + c.email)[#c.email]) }
  parts
}
#let line2 = {
  let parts = ()
  if "linkedin" in c and c.linkedin != "" { parts.push(link("https://" + c.linkedin)[#("https://" + c.linkedin)]) }
  if "github" in c and c.github != "" { parts.push(link("https://" + c.github)[#("https://" + c.github)]) }
  if "website" in c and c.website != "" { parts.push(link("https://" + c.website)[#("https://" + c.website)]) }
  parts
}
#let sep = [ #text(fill: rgb("#999999"))[|] ]

#align(center)[
  #text(size: 9.5pt)[#line1.join(sep)]
  #if line2.len() > 0 [
    #v(0.1em)
    #text(size: 9.5pt)[#line2.join(sep)]
  ]
]

// ---------- Summary ----------
#let effective-summary = variant.at("summary", default: data.at("summary", default: none))
#if effective-summary != none and effective-summary != "" [
  #section("Summary")
  #text(size: 9.7pt)[#effective-summary]
]

// ---------- Experience ----------
// Note: the gap is placed BEFORE each entry (skipping the first) rather than
// after every entry. That way the last entry's trailing space doesn't stack
// with the next section heading's own spacing, which was producing an extra,
// unwanted blank line when the text was copy-pasted / extracted.
#if "experience" in data and data.experience.len() > 0 [
  #section("Experience")
  #for (i, job) in data.experience.enumerate() [
    #if i > 0 { v(1.5em) }
    #entry(
      job.company + if "location" in job and job.location != "" { ", " + job.location } else { "" },
      job.role,
      job.start + " - " + job.end,
      filter-bullets(job.at("bullets", default: ())),
    )
  ]
]

// ---------- Projects ----------
#let shown-projects = filter-entries(data.at("projects", default: ()))
#if shown-projects.len() > 0 [
  #section("Projects")
  #for (i, proj) in shown-projects.enumerate() [
    #if i > 0 { v(1.5em) }
    #entry(
      proj.name,
      proj.at("tech", default: none),
      "",
      filter-bullets(proj.at("bullets", default: ())),
    )
  ]
]

// ---------- Education ----------
#if "education" in data and data.education.len() > 0 [
  #section("Education")
  #for (i, edu) in data.education.enumerate() [
    #if i > 0 { v(1.5em) }
    #let school = edu.at("school", default: "")
    #let loc = if "location" in edu and edu.location != "" {
      if school != "" { ", " + edu.location } else { edu.location }
    } else {
      ""
    }
    #let dates = if "start" in edu and edu.start != "" and "end" in edu and edu.end != "" {
      if edu.start == edu.end { edu.start } else { edu.start + " - " + edu.end }
    } else if "end" in edu and edu.end != "" {
      edu.end
    } else if "start" in edu and edu.start != "" {
      edu.start
    } else {
      ""
    }
    #entry(
      school + loc,
      edu.at("degree", default: none),
      dates,
      edu.at("details", default: ()),
    )
  ]
]

// ---------- Skills ----------
#if "skills" in data and data.skills.len() > 0 [
  #section("Skills")
  #for group in data.skills [
    #block(below: 0.3em)[
      #text(weight: "bold", size: 9.8pt)[#group.category: ]
      #text(size: 9.8pt)[#group.items.join(", ")]
    ]
  ]
]

// ---------- Certifications ----------
// Kept as its own section (never folded into Skills) since ATS systems
// commonly score/search the "Certifications" heading independently.
#if "certifications" in data and data.certifications.len() > 0 [
  #section("Certifications")
  #bullets(data.certifications)
]
