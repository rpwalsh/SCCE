# Multilingual Contract

SCCE must not use English natural-language labels, English taxonomies, or hand-authored language-specific relation names as ontology.

Internal engineering primitives may use stable ASCII IDs when the runtime treats them as opaque identifiers rather than linguistic meaning. Source-derived labels, aliases, and evidence text must remain separate from those IDs.

All linguistic labels must be source-derived or attached as locale-specific metadata. The system must learn from multilingual corpora and preserve source language evidence. English is only one corpus language, not the ontology.

Evidence offsets are UTF-8-byte exact while source text remains Unicode. Local tests cover multilingual text, CRLF normalization, source-label separation, correction learning, and translation preservation. These tests establish contract behavior within their fixtures; representative multilingual quality remains unmeasured.
