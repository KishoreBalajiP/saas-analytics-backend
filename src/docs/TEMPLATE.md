# Documentation Template

> **WHAT this file is:** the canonical template every new documentation
> file MUST follow. It is itself a complete example of the standard.
> **WHY it exists:** every document should be self-contained, scannable
> and useful for both onboarding and interview preparation.
> **HOW to use it:** copy the skeleton from [§ Skeleton](#skeleton)
> into a new file, then fill in the sections in order. Skip sections
> that are not relevant — but every skipped section must have a
> one-line *not applicable* note in its place so the structure stays
> uniform.
> **WHEN to update this template:** when the documentation standard
> itself changes. That is rare; document the change in `CHANGELOG.md`.
> **WHERE it lives:** `src/docs/TEMPLATE.md`.

---

## Section Catalogue

Every document has up to fifteen sections, in this order. Sections
marked **(required)** must always be present. Sections marked
**(when relevant)** may carry a single *Not applicable* line instead
of being omitted.

| # | Section | Status | Purpose |
| - | --- | --- | --- |
| 1 | Title | (required) | The first H1. Answers *"what is this document about?"* in five words or fewer. |
| 2 | Purpose | (required) | Five-line WHAT / WHY / HOW / WHEN / WHERE block. Always present. |
| 3 | Intended Audience | (required) | Who should read this document. Concrete roles, not abstract personas. |
| 4 | Current Status | (required) | One of: `Completed` / `In Progress` / `Planned` / `Future`. Plus the sprint that produced it. |
| 5 | Business Perspective | (when relevant) | Why this exists from the business point of view. *Not* marketing copy. |
| 6 | Technical Perspective | (when relevant) | What the engineer needs to know about how this works. |
| 7 | Architecture | (when relevant) | ASCII diagrams, file pointers, dependency direction. |
| 8 | Real-world Examples | (when relevant) | End-to-end examples that actually run against the code. |
| 9 | Best Practices | (when relevant) | What to do and why. |
| 10 | Common Mistakes | (when relevant) | What *not* to do and why. |
| 11 | Summary | (required) | Three- to five-line recap. |
| 12 | Key Takeaways | (required) | Three to seven bullets. The reader should be able to skim this and remember the document. |
| 13 | Interview Preparation | (required) | Common questions, sample answers, real-world examples, common mistakes. |
| 14 | Related Documents | (required) | Real links to other docs in the project. |
| 15 | Last Updated | (required) | Sprint, Phase, Date, Author. |

---

## Conventions

### Voice

- **Engineers talk to engineers.** No marketing language. No aspirational
  claims. No "best-in-class".
- **Explain *why*.** Every *what* is followed by a *why*. A reader who
  only learns *what* cannot defend the choice in a code review.
- **Use ASCII diagrams.** They render in every terminal, every IDE,
  every GitHub view.

### Cross-references

- Every related-doc link must point to a file that actually exists.
- Use relative paths (`./STATUS.md`, `../src/middleware/...`).
- When you rename a file, fix every link to it in the same commit.

### Examples

- Examples in docs must *run* against the code. No pseudocode.
- When the code changes, update the example in the same commit.

### Status labels

Use exactly one of:

- `Completed` — code is in the repo and tested.
- `In Progress` — actively being worked on in the current sprint.
- `Planned` — scheduled in a future sprint; design is firm.
- `Future` — discussed, not scheduled. Cannot be cited as a deliverable.

Do not invent new labels. If a document is `Planned` but a sprint is
later cancelled, demote to `Future` — do not delete the section.

### "Last Updated" block

```
## Last Updated

- **Sprint:** Sprint N
- **Phase:** Phase N — <name>
- **Date:** YYYY-MM-DD
- **Author:** Documentation (<initials or role>)
```

Update this block as part of the same commit that changes the doc.
CI guard `check-readme-sync` enforces the existence of the file but
not the freshness of the block — keep it honest manually.

---

## Skeleton

Copy from `§ Skeleton` (below) when creating a new document. Replace
the placeholder text with real content. Remove any `(when relevant)`
section that does not apply, leaving a single line:

> *Not applicable to this document.*

---

### Title

# NN — Document Name

### Purpose (required)

> **WHAT this is:** one sentence.
> **WHY it exists:** one sentence.
> **HOW to use it:** one sentence.
> **WHEN to update it:** one sentence.
> **WHERE it lives:** `src/docs/<path>`.

### Intended Audience (required)

| Reader | What they get |
| --- | --- |
| **<role>** | <value>. |
| **<role>** | <value>. |

### Current Status (required)

> **Status:** `Completed` / `In Progress` / `Planned` / `Future`.
> **Sprint:** Sprint N.
> **Owner:** <role>.

### Business Perspective *(when relevant)*

<Why this exists from the business point of view. Reference the
project vision in `02-project-vision.md` where appropriate.>

### Technical Perspective *(when relevant)*

<What the engineer needs to know. Cite real files in the repo.>

### Architecture *(when relevant)*

```
┌─────────────────────┐
│       <thing>       │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│       <thing>       │
└─────────────────────┘
```

> Cite the actual file path: see
> `[src/path/to/file](../../src/path/to/file.js)`.

### Real-world Examples *(when relevant)*

<An example that runs against the actual code. Include the exact
command or HTTP request and the expected response.>

### Best Practices *(when relevant)*

| Do | Why |
| --- | --- |
| **<practice>** | <reason>. |

### Common Mistakes *(when relevant)*

| Don't | Why |
| --- | --- |
| **<mistake>** | <reason>. |

### Summary (required)

<Three- to five-line recap.>

### Key Takeaways (required)

- <Bullet one — most important thing>.
- <Bullet two>.
- <Bullet three>.

### Interview Preparation (required)

#### Common Questions

- "<question>"

#### Sample Answers

> **"<question>"** — <answer that cites the actual code or ADR>.

#### Real-world Examples

- <A real workflow that exercises this topic>.

#### Common Mistakes

- <What candidates get wrong about this topic>.

### Related Documents (required)

- [`<doc>`](./<doc>.md) — <one-line description>.

### Last Updated (required)

- **Sprint:** Sprint N
- **Phase:** Phase N — <name>
- **Date:** YYYY-MM-DD
- **Author:** Documentation (<role>)

---

## What This Template Is Not

- Not a creative-writing exercise. Boilerplate sections are fine; the
  point is consistency, not literary flair.
- Not a substitute for thinking. The template tells you *what to
  write about*; you must still decide *what to say*.
- Not a substitute for review. Every PR that adds or restructures a
  document must be reviewed against this template.

---

## Change Log for This Template

| Date | Change | Author |
| --- | --- | --- |
| Sprint 0 close | Initial 15-section template. | Documentation (Sprint 0) |

---

## Summary

`TEMPLATE.md` is the canonical standard for every new document in this
repository. It defines 15 sections in a fixed order, separates
required from optional content, and provides a skeleton ready to copy.
Apply it consistently; reviewers can spot drift in seconds.

## Key Takeaways

- Required sections (Title, Purpose, Intended Audience, Current
  Status, Summary, Key Takeaways, Interview Preparation, Related
  Documents, Last Updated) are never omitted.
- Optional sections (Business Perspective, Technical Perspective,
  Architecture, Real-world Examples, Best Practices, Common Mistakes)
  are included when they add value, otherwise marked *Not applicable*.
- The skeleton at the top is the actual template — copy from there.

## Interview Preparation

### Common Questions

- "How do you keep documentation consistent across a growing team?"
- "What's the difference between a README and an internal
  documentation template?"
- "Why use a fixed template instead of free-form writing?"

### Sample Answers

- **"How do you keep docs consistent?"** — A single template file
  defines the structure; every new document copies its skeleton;
  reviewers check the structure mechanically; the
  `check-readme-sync` CI guard enforces the existence of the file.
  When the template changes (rare), every existing document is
  updated in the same PR.

- **"README vs internal template?"** — README is the *public* face of
  the repository. The internal template is the *engineering* contract
  — every internal document follows it; READMEs do not.

- **"Why fixed-template?"** — Two reasons. First, readers learn the
  pattern once and then skim every document the same way; the
  `Key Takeaways` block is always at the end of the body, the
  *Last Updated* block is always at the bottom. Second, reviewers can
  check structure instead of content; structural drift is a CI
  failure, not a taste argument.

### Real-World Examples

- A new engineer opens `TEMPLATE.md`, copies the skeleton into
  `04-business-flow.md`, fills in the sections, opens a PR. The
  reviewer runs `npm run ci:guards` (no new guard needed; structural
  drift is obvious from the diff), comments on the *Key Takeaways*
  bullet count, and merges.

### Common Mistakes

- Inventing a new section name (e.g. *TL;DR*) instead of using the
  existing *Summary*. If you need a new section, propose it here
  first.
- Removing a required section because "it does not apply". The
  standard is non-negotiable; mark *Not applicable* inside the
  section instead.
- Skipping the *Last Updated* block. Reviewers must always know when
  the doc last changed.

## Related Documents

- [`README.md`](./README.md) — documentation homepage (lists this
  template under "Documentation Rules")
- [`STATUS.md`](./STATUS.md) — daily-read project state
- [`01-getting-started.md`](./01-getting-started.md) — onboarding
- [`02-project-vision.md`](./02-project-vision.md) — business vision
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system architecture
- [`DECISIONS.md`](./DECISIONS.md) — architectural decisions

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)