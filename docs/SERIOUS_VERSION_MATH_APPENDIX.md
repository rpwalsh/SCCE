# SCCE Serious-Version Math Contract

This repository must move from heuristic scoring to learned, calibrated, inspectable graph cognition.

Heuristics may remain as:

- bootstrap features,
- guard flags,
- deterministic fallbacks,
- CPU/memory safety limits,
- explainable priors before training data exists.

Heuristics must not remain as final intelligence.

Every important score must become one of:

1. an algebraic invariant,
2. a learned estimator,
3. a calibrated probability,
4. a guard/fallback flag,
5. a traceable feature used by another estimator.

---

## 0. Core notation

Let the legal training corpus be:

$$
D=\{d_1,d_2,\ldots,d_N\}
$$

Each document is segmented into evidence spans:

$$
S=\{s_i\}
$$

Each span produces candidate observations:

$$
o=(h,r,t,q,\epsilon)
$$

where:

- $h$ = head entity / construct,
- $r$ = relation / predicate / action,
- $t$ = tail entity / construct,
- $q$ = qualifiers: time, modality, negation, quantity, source conditions,
- $\epsilon$ = source evidence pointer.

The durable SCCE brain is a typed temporal hypergraph:

$$
\mathcal{H}_\tau=(V,E,\phi,\psi,\tau,\rho)
$$

where:

- $V$ = nodes: entities, claims, concepts, code symbols, documents, users, tasks, language units,
- $E$ = typed hyperedges,
- $\phi:V\rightarrow T_V$ maps nodes to language-neutral node types,
- $\psi:E\rightarrow T_E$ maps edges to language-neutral edge types,
- $\tau(e)$ gives temporal validity or event time,
- $\rho(e)$ stores provenance and source evidence.

Do not seed English taxonomies. Type IDs must be language-neutral, source-derived, or internally opaque.

---

## 1. Evidence-span to observation extraction

The extraction layer estimates:

$$
P(o \mid s)
$$

for candidate observation $o$ from evidence span $s$.

Initial implementation may use features, but the estimator must be explicit:

$$
P(o\mid s)=\sigma(\theta_o^\top f(s,o))
$$

where $f(s,o)$ includes:

- entity match confidence,
- predicate/role confidence,
- time extraction confidence,
- negation/modality confidence,
- quantity/unit preservation,
- syntax/frame fit,
- source quality,
- language profile confidence.

Training loss:

$$
L_{\text{obs}} =
-\sum_{(s,o,y)}
\left[
y\log P(o\mid s)+(1-y)\log(1-P(o\mid s))
\right]
$$

Add hard penalties for critical extraction failures:

$$
\begin{aligned}
L_{\text{extract}}
={}&L_{\text{obs}}
+\lambda_n L_{\text{negation}}
+\lambda_t L_{\text{time}} \\
&+\lambda_u L_{\text{unit}}
+\lambda_m L_{\text{modality}}
\end{aligned}
$$

Acceptance:

- "X caused Y" and "X did not cause Y" must produce different observations.
- "X may cause Y" and "X causes Y" must produce different force/modality.
- Numeric, date, unit, URL, and code-symbol evidence must be preserved exactly.

---

## 2. Entity and claim canonicalization

Surface forms are not entities. SCCE must estimate whether two mentions refer to the same canonical node.

For mentions $a,b$:

$$
P(a\equiv b)=\sigma(\theta_m^\top f(a,b))
$$

Features include:

- surface similarity,
- alias evidence,
- shared source context,
- co-reference context,
- temporal compatibility,
- type compatibility,
- graph-neighborhood similarity,
- contradiction risk,
- source reliability.

Canonical clustering objective:

$$
\begin{aligned}
C^*=\arg\max_C \Bigg[
&\sum_{(a,b)\in C} \log P(a\equiv b)
-\sum_{(a,b)\notin C} \log P(a\equiv b) \\
&-\lambda_{\text{over}}R_{\text{overmerge}}
-\lambda_{\text{under}}R_{\text{undermerge}}
\Bigg]
\end{aligned}
$$

Canonicalization must preserve temporal identity:

$$
\operatorname{entity}(t_1)\neq \operatorname{entity}(t_2)
$$

when evidence shows identity changed over time.

Acceptance:

- Aliases merge only with evidence.
- Similar names do not merge without supporting context.
- Claims that changed over time must retain separate temporal validity intervals.

---

## 3. Claim belief, contradiction, and truth maintenance

A claim cluster $c$ has supporting evidence $E_c^+$, contradicting evidence $E_c^-$, and unknown/weak evidence $E_c^0$.

Evidence weight:

$$
\begin{aligned}
w_i={}&r_{\text{source}}(i)
\cdot r_{\text{directness}}(i)
\cdot r_{\text{freshness}}(i,t) \\
&\cdot r_{\text{extraction}}(i)
\cdot r_{\text{diversity}}(i)
\end{aligned}
$$

Support mass:

$$
S_c=\sum_{i\in E_c^+} w_i
$$

Contradiction mass:

$$
K_c=\sum_{i\in E_c^-} w_i
$$

Uncertainty mass:

$$
U_c=\sum_{i\in E_c^0} w_i+\epsilon
$$

Belief interval:

$$
\operatorname{Bel}(c)=\frac{S_c}{S_c+K_c+U_c}
$$

$$
\operatorname{Plaus}(c)=\frac{S_c+U_c}{S_c+K_c+U_c}
$$

Contradiction ratio:

$$
\operatorname{Contr}(c)=\frac{K_c}{S_c+K_c+U_c}
$$

Truth state is not a single scalar. It is:

$$
\operatorname{TruthState}(c)=
\left(
\operatorname{Bel}(c),
\operatorname{Plaus}(c),
\operatorname{Contr}(c),
\operatorname{validity}(c),
\operatorname{force}(c)
\right)
$$

Acceptance:

- Direct evidence, inference, prior, analogy, conjecture, and creative generation must be distinct.
- Contradictory evidence must not be averaged away.
- Stale evidence must not silently overwrite fresh evidence.
- No unsupported answer may be labeled source-backed.

---

## 4. Typed temporal graph activation

For a query/task $q$, each edge $e$ receives task-conditioned activation:

$$
\begin{aligned}
a_e(q,t)={}&\sigma(\beta^\top f_e(q,t))
\cdot \exp(-\lambda_{\psi(e)}\Delta t) \\
&\cdot g_{\text{provenance}}(e)
\cdot g_{\text{truth}}(e)
\end{aligned}
$$

where:

$$
\Delta t=\max(0,t-\tau(e))
$$

and $f_e(q,t)$ includes:

- query-slot compatibility,
- relation type,
- source reliability,
- temporal relevance,
- contradiction mass,
- graph-neighborhood fit,
- user/project context,
- language/profile fit.

Graph transition probability:

$$
P_q(u\mid v) =
\frac{
\sum_{e:v\rightarrow u} a_e(q,t)
}{
\sum_{u'}\sum_{e:v\rightarrow u'} a_e(q,t)+\epsilon
}
$$

Personalized activation / random walk:

$$
\pi_q
=\alpha p_q+(1-\alpha)P_q^\top \pi_q
$$

where:

- $p_q$ = query/task prior over start nodes,
- $\alpha$ = restart probability.

Important: $\alpha$ is a graph-walk restart parameter. If the project uses $1/137$, it must be treated as a configurable symbolic prior, not physical proof.

Acceptance:

- Activation must be traceable edge-by-edge.
- Temporal decay must be typed.
- Contradiction and stale evidence must reduce activation.
- Restart probability must not be marketed as physics.

---

## 5. Learned graph representations

Stable hash vectors may remain as deterministic fallback features. They are not learned embeddings.

SCCE must add learned graph objectives.

For typed link prediction:

$$
P((h,r,t)\in E)
=\sigma(z_h^\top R_r z_t + b_r)
$$

Loss:

$$
\begin{aligned}
L_{\text{link}}={}&-\sum_{(h,r,t)\in E}
\log \sigma(z_h^\top R_r z_t) \\
&-\sum_{(h,r,t')\in E^-}
\log \sigma(-z_h^\top R_r z_{t'})
\end{aligned}
$$

For path reconstruction:

$$
L_{\text{path}}
=-\log P(v_m\mid v_0,r_1,\ldots,r_k,v_k)
$$

For evidence-to-construct alignment, use contrastive loss:

$$
L_{\text{align}}
=-\log
\frac{
\exp(\operatorname{sim}(z_s,z_c)/\tau)
}{
\sum_{c'}\exp(\operatorname{sim}(z_s,z_{c'})/\tau)
}
$$

For temporal prediction:

$$
L_{\text{time}}
=-\log P(e_{t+\Delta}\mid \mathcal{H}_t)
$$

Overall graph representation objective:

$$
\begin{aligned}
L_{\text{graph}}={}&
\lambda_1L_{\text{link}}
+\lambda_2L_{\text{path}}
+\lambda_3L_{\text{align}} \\
&+\lambda_4L_{\text{time}}
+\lambda_5\Omega(z)
\end{aligned}
$$

Acceptance:

- Learned graph representation must demonstrate held-out improvement over the lexical/hash baseline.
- Learned evidence-to-construct retrieval must demonstrate held-out improvement over the lexical/hash baseline.
- Training snapshots must be versioned and inspectable.

---

## 6. Retrieval as value of information

Retrieval must not mean "highest text overlap." It must optimize expected answer utility.

For slot $s$ and evidence candidate $e$:

$$
\operatorname{VOI}(e\mid s,q)
=\mathbb{E}\left[U(A\cup e,q)-U(A,q)\right]-\operatorname{Cost}(e)
$$

Approximate score:

$$
\begin{aligned}
R(e,s,q)={}&w_1\operatorname{Support}(e,s)
+w_2\operatorname{ContradictionValue}(e,s)
+w_3\operatorname{DefinitionValue}(e,s) \\
&+w_4\operatorname{Freshness}(e,s)
+w_5\operatorname{SourceDiversity}(e,s) \\
&-w_6\operatorname{Redundancy}(e,A)
-w_7\operatorname{Cost}(e)
\end{aligned}
$$

But the $w_i$ must be learned/calibrated or marked provisional.

Retrieval must classify evidence role:

$$
\operatorname{role}(e,s)\in
\left\{
\mathrm{support},
\mathrm{contradiction},
\mathrm{definition},
\mathrm{example},
\mathrm{counterexample},
\mathrm{source\_context},
\mathrm{code\_symbol},
\mathrm{test\_evidence}
\right\}
$$

Acceptance:

- Retrieval must return contradiction evidence when available.
- Retrieval must support source-bound answers.
- Retrieval must know when evidence is insufficient.
- Code retrieval must prefer source symbols, tests, configs, call paths, and build logs over README prose.

---

## 7. Question slot planning

A user request $q$ is decomposed into slots:

$$
\operatorname{Slots}(q)=\{s_1,s_2,\ldots,s_k\}
$$

Each slot has:

$$
s_i=\left(
\mathrm{intent}_i,
\mathrm{evidenceNeed}_i,
\mathrm{proofNeed}_i,
\mathrm{answerRole}_i,
\mathrm{priority}_i
\right)
$$

Slot plan objective:

$$
\begin{aligned}
S^*=\arg\max_S \Big[
&\operatorname{Coverage}(S,q)
+\operatorname{Utility}(S,q)
+\operatorname{Actionability}(S,q) \\
&-\operatorname{Ambiguity}(S,q)
-\operatorname{Cost}(S)
\Big]
\end{aligned}
$$

Slot evidence need:

$$
\operatorname{Need}(s_i)=\left(
\mathrm{type}_i,
\mathrm{force}_i,
\mathrm{freshness}_i,
\mathrm{sourceScope}_i,
\mathrm{actionScope}_i
\right)
$$

Acceptance:

- Broad questions are decomposed into useful slots.
- Multi-part questions do not collapse into one answer blob.
- Source-bound requests require stronger evidence force.
- Creative requests may use conjecture/creative force but cannot masquerade as fact.

---

## 8. Answer graph and discourse graph

Before prose, SCCE must build an answer graph.

Candidate answer graph:

$$
A=(C,S,K,X,U)
$$

where:

- $C$ = claims,
- $S$ = supporting evidence links,
- $K$ = caveats/contradictions,
- $X$ = examples/actions,
- $U$ = uncertainty/unknowns.

Select answer graph:

$$
\begin{aligned}
A^*=\arg\max_A \Big[
&\operatorname{SlotCoverage}(A)
+\operatorname{BeliefSupport}(A)
+\operatorname{EvidenceDiversity}(A) \\
&+\operatorname{UserUtility}(A)
+\operatorname{Actionability}(A)
-\operatorname{ContradictionLeak}(A) \\
&-\operatorname{UnsupportedClaim}(A)
-\operatorname{VerbosityCost}(A)
\Big]
\end{aligned}
$$

Then convert to discourse graph:

$$
D_g=\operatorname{Discourse}
\left(A^*,\mathrm{style},\mathrm{length},\mathrm{languageProfile}\right)
$$

Discourse nodes include language-neutral equivalents of:

- main claim,
- support,
- contrast,
- caveat,
- example,
- action,
- uncertainty,
- next step.

Acceptance:

- The same answer graph can produce concise, detailed, technical, or layperson responses.
- Changing style must not change factual content.
- Required claims and caveats must survive surface generation.

---

## 9. Mouth: constrained semantic-to-surface realization

The mouth solves a constrained generation problem. It must not decide truth.

For answer graph $A^*$, find surface text $y$:

$$
\begin{aligned}
y^*=\arg\max_y \Big[
&\lambda_1 \operatorname{MeaningPreservation}(A^*,y)
+\lambda_2 \operatorname{RequiredSlotCoverage}(A^*,y) \\
&+\lambda_3 \operatorname{EvidenceCoverage}(A^*,y)
+\lambda_4 \operatorname{Fluency}(y)
+\lambda_5 \operatorname{StyleFit}(y,u) \\
&+\lambda_6 \operatorname{Actionability}(y)
-\lambda_7 \operatorname{UnsupportedContent}(A^*,y) \\
&-\lambda_8 \operatorname{ContradictionLeak}(A^*,y)
-\lambda_9 \operatorname{Repetition}(y) \\
&-\lambda_{10} \operatorname{VerbosityBloat}(y)
\Big]
\end{aligned}
$$

Hard constraints:

$$
\operatorname{Preserve}
\left(
\mathrm{numbers},
\mathrm{dates},
\mathrm{urls},
\mathrm{codeSymbols},
\mathrm{quotedTerms}
\right)
=\mathrm{true}
$$

$$
\operatorname{UnsupportedContent}(A^*,y)=0
$$

in source-bound factual mode.

Kneser-Ney language memory may contribute only to:

$$
\operatorname{Fluency}(y)
=\frac{1}{|y|}\sum_i \log P_{\mathrm{KN}}(w_i\mid h_i)
$$

Kneser-Ney must not introduce factual content.

Acceptance:

- Mouth improves fluency without adding facts.
- Entity/code/number preservation is tested.
- Surface generation has traceable score terms.
- Unsupported claims are detected before output.

---

## 10. Translation and multilingual transfer

Translation is meaning transfer, not word substitution.

For source text $x$, target text $y$, source construct graph $G_x$, and target construct graph $G_y$:

$$
\begin{aligned}
\operatorname{Loss}_{\text{trans}}(x,y)={}&
\lambda_1 d(G_x,G_y)
+\lambda_2 \operatorname{EntityLoss}(x,y)
+\lambda_3 \operatorname{NumberLoss}(x,y) \\
&+\lambda_4 \operatorname{CodeSymbolLoss}(x,y)
+\lambda_5 \operatorname{PlaceholderLoss}(x,y) \\
&+\lambda_6 \operatorname{RoundTripLoss}(x,y)
-\lambda_7 \operatorname{FluencyTarget}(y)
\end{aligned}
$$

Alignment score:

$$
\begin{aligned}
A(s,t)={}&w_l\operatorname{Lex}(s,t)
+w_p\operatorname{Phrase}(s,t)
+w_f\operatorname{Frame}(s,t) \\
&+w_a\operatorname{Anchor}(s,t)
+w_c\operatorname{Correction}(s,t)
-w_h\operatorname{Hallucination}(s,t)
\end{aligned}
$$

Round-trip validation:

$$
\operatorname{RT}(x,y)=d(G_x,G_{\hat{x}})
$$

where $\hat{x}$ is the source-language reconstruction from target meaning.

Acceptance:

- Unknown terms become glosses or uncertainty, not hallucinations.
- User correction improves future translation.
- Scripts are not languages.
- Target fluency cannot override source meaning.

---

## 11. Code intelligence math

Code must be represented as program structure, not prose.

Repository graph:

$$
G_{\text{code}}=
(V_{\text{sym}},E_{\text{ast}},E_{\text{call}},E_{\text{type}},E_{\text{data}},E_{\text{test}},E_{\text{config}})
$$

Patch candidate $\Delta$ is selected by:

$$
\begin{aligned}
\Delta^*=\arg\max_\Delta \Big[
&P(\mathrm{testsPass}\mid G_{\text{code}},\Delta)
+P(\mathrm{issueFixed}\mid G_{\text{code}},\Delta) \\
&+\operatorname{Minimality}(\Delta)
+\operatorname{StyleConsistency}(\Delta) \\
&-\operatorname{RegressionRisk}(\Delta)
-\operatorname{ScopeCreep}(\Delta)
\Big]
\end{aligned}
$$

Fault localization:

$$
P(\mathrm{fault}=n\mid \mathrm{failure})
\propto
P(\mathrm{failure}\mid n)
P(n\mid \mathrm{recentChanges},\mathrm{coverage},\mathrm{dependencyPath})
$$

Patch ranking loss from outcomes:

$$
L_{\text{patch-rank}}
=-\log \sigma(\operatorname{score}(\Delta^+)-\operatorname{score}(\Delta^-))
$$

Acceptance:

- SCCE must use AST/symbol/call/test/config evidence for code tasks.
- Dry-run patches must cite source structure and expected test impact.
- Failed patches must reduce similar future patch scores.
- Successful patches must increase similar future patch scores.

---

## 12. Calibration

Raw scores are not confidence.

For task class $k$, raw score $r$ becomes calibrated probability:

$$
p_k=\operatorname{Cal}_k(r)
$$

where $\operatorname{Cal}_k$ may be isotonic regression, logistic calibration, or another explicit calibrator.

Brier score:

$$
L_{\text{Brier}} =
\frac{1}{N}\sum_i(p_i-y_i)^2
$$

Negative log likelihood:

$$
L_{\text{NLL}}
=-\sum_i\left[
y_i\log p_i+(1-y_i)\log(1-p_i)
\right]
$$

Expected calibration error:

$$
\mathrm{ECE} =
\sum_{b=1}^{B}
\frac{|B_b|}{N}
\left|
\operatorname{acc}(B_b)-\operatorname{conf}(B_b)
\right|
$$

Acceptance:

- No score may be called confidence unless calibrated or explicitly marked uncalibrated.
- Runtime must expose calibration ID, task class, and reliability status.
- Answer support, retrieval success, translation preservation, and patch success require calibration tests.

---

## 13. Feedback and outcome learning

Every user correction or task outcome becomes training signal.

Outcome record:

$$
o_t=(q,A,y,\mathrm{feedback},\mathrm{tests},\mathrm{corrections},\mathrm{scoreTrace})
$$

Preference/ranking loss:

$$
L_{\text{pref}}
=-\log\sigma(\operatorname{score}(y^+)-\operatorname{score}(y^-))
$$

Correction loss:

$$
L_{\text{corr}}
=d(G_{\text{correct}},G_{\text{future}})
+\operatorname{SurfaceLoss}(y_{\text{correct}},y_{\text{future}})
$$

Retrieval outcome update:

$$
\operatorname{score}_{\text{new}}(\mathrm{path})
=\operatorname{score}_{\text{old}}(\mathrm{path})
+\eta(\mathrm{reward}-\mathrm{baseline})
$$

Acceptance:

- User correction changes future output in tests.
- Accepted answers improve similar future ranking.
- Rejected answers reduce similar future ranking.
- Passing/failing code patches update patch policy.

---

## 14. Overall training objective

The serious SCCE brain minimizes:

$$
\begin{aligned}
\min_B \Big[
&L_{\text{extract}}
+L_{\text{canon}}
+L_{\text{belief}}
+L_{\text{graph}} \\
&+L_{\text{retrieval}}
+L_{\text{slot}}
+L_{\text{discourse}}
+L_{\text{mouth}} \\
&+L_{\text{translation}}
+L_{\text{code}}
+L_{\text{calibration}}
+L_{\text{feedback}}
+\Omega(B)
\Big]
\end{aligned}
$$

where $\Omega(B)$ enforces:

- bounded memory,
- bounded CPU,
- deterministic replay,
- inspectability,
- source provenance,
- compression,
- old-laptop viability.

The legal internet is not the model.

The compressed, typed, calibrated, inspectable graph brain $B$ is the model.

---

## 15. Replacement rule for existing heuristics

Every existing hand score must be converted as follows:

$$
\operatorname{heuristicScore}(x)
\rightarrow
\operatorname{feature}_i(x)
$$

Then either:

$$
\operatorname{Estimator}(x)=\sigma(\theta^\top f(x))
$$

or:

$$
\operatorname{CalibratedProbability}(x)
=\operatorname{Cal}(\operatorname{Estimator}(x))
$$

or:

$$
\operatorname{GuardFlag}(x)\in\{0,1\}
$$

or:

$$
\operatorname{Invariant}(x)=\mathrm{true}/\mathrm{false}
$$

No hand-weighted score may remain the final decision unless marked provisional and covered by a test that documents the limitation.

---

## 16. Minimum serious acceptance test

The implementation is not serious until these are true:

1. Learned graph representation demonstrates held-out improvement over the lexical/hash baseline.
2. Retrieval returns support and contradiction evidence.
3. Slot planner drives answer shape.
4. Mouth preserves meaning while improving fluency.
5. Translation improves from correction memory.
6. Code intelligence uses actual program structure.
7. Confidence scores are calibrated or marked uncalibrated.
8. Every final answer has score traces.
9. No external inference provider, hosted model, retrieval-to-prompt fallback, or English seed taxonomy is introduced.
10. Old-laptop CPU/memory constraints remain first-class.

The short version: the math should use optimization, calibration, and algebraic guards rather than unexplained constants.

The serious equation is:

$$
\begin{aligned}
\text{SCCE}={}&
\text{typed graph compression}
+\text{learned graph objectives} \\
&+\text{truth maintenance}
+\text{retrieval value}
+\text{discourse planning} \\
&+\text{constrained mouth realization}
+\text{calibrated feedback learning}
\end{aligned}
$$

That is the bridge from provisional graph heuristics to calibrated, inspectable graph cognition.
