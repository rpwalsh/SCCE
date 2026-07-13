export const GRAPH_QUALITY_CLASS_IDS = {
  answerGrade: "qr.gq.0b4f2a19",
  weakFragment: "qr.gq.6d91c3e0",
  catalogNavigation: "qr.gq.8a13d72b",
  redirectAlias: "qr.gq.50f2b6c8",
  titleHint: "qr.gq.a7e40d93",
  noisyMarkup: "qr.gq.3c85f11d",
  unknown: "qr.gq.f0d4a628"
} as const;

export type GraphQualityClassId = typeof GRAPH_QUALITY_CLASS_IDS[keyof typeof GRAPH_QUALITY_CLASS_IDS];

export const GRAPH_QUALITY_REASON_IDS = {
  lowMassPredicate: "qr.gqr.0e58c1a7",
  lowInformationSubject: "qr.gqr.4d9b2f60",
  lowInformationObject: "qr.gqr.b83e5a20",
  functionPredicate: "qr.gqr.27c0a4f9",
  subjectFragment: "qr.gqr.a6e19c42",
  objectFragment: "qr.gqr.d142f7e0",
  longObject: "qr.gqr.68c3d50b",
  markupDense: "qr.gqr.932b4e18",
  navigationShape: "qr.gqr.5fa728d3",
  aliasShape: "qr.gqr.7e04b1a6",
  profileHintShape: "qr.gqr.c8d03b5e",
  semanticShape: "qr.gqr.1f9a60d4",
  classAnswerGrade: "qr.gqc.0b4f2a19",
  classWeakFragment: "qr.gqc.6d91c3e0",
  classCatalogNavigation: "qr.gqc.8a13d72b",
  classRedirectAlias: "qr.gqc.50f2b6c8",
  classTitleHint: "qr.gqc.a7e40d93",
  classNoisyMarkup: "qr.gqc.3c85f11d",
  classUnknown: "qr.gqc.f0d4a628"
} as const;

export type GraphQualityReasonId = typeof GRAPH_QUALITY_REASON_IDS[keyof typeof GRAPH_QUALITY_REASON_IDS];

export const GRAPH_QUALITY_CLASS_REASON_IDS: Record<GraphQualityClassId, GraphQualityReasonId> = {
  [GRAPH_QUALITY_CLASS_IDS.answerGrade]: GRAPH_QUALITY_REASON_IDS.classAnswerGrade,
  [GRAPH_QUALITY_CLASS_IDS.weakFragment]: GRAPH_QUALITY_REASON_IDS.classWeakFragment,
  [GRAPH_QUALITY_CLASS_IDS.catalogNavigation]: GRAPH_QUALITY_REASON_IDS.classCatalogNavigation,
  [GRAPH_QUALITY_CLASS_IDS.redirectAlias]: GRAPH_QUALITY_REASON_IDS.classRedirectAlias,
  [GRAPH_QUALITY_CLASS_IDS.titleHint]: GRAPH_QUALITY_REASON_IDS.classTitleHint,
  [GRAPH_QUALITY_CLASS_IDS.noisyMarkup]: GRAPH_QUALITY_REASON_IDS.classNoisyMarkup,
  [GRAPH_QUALITY_CLASS_IDS.unknown]: GRAPH_QUALITY_REASON_IDS.classUnknown
};

export const QUESTION_EDGE_DECISION_IDS = {
  directEvidence: "qr.qd.4871f6b0",
  requestedSupport: "qr.qd.0a6c9e21",
  partialSupport: "qr.qd.6e3f2a48",
  requestedSlotMissing: "qr.qd.91d40c7b",
  ambiguousSense: "qr.qd.e72b5f09",
  weakGraphOnly: "qr.qd.4f0b8a13",
  insufficientSupport: "qr.qd.c3a917e5",
  clarificationCosted: "qr.qd.b12e46a0",
  languageOnlyRejected: "qr.qd.2d08f7c4"
} as const;

export type QuestionEdgeDecisionId = typeof QUESTION_EDGE_DECISION_IDS[keyof typeof QUESTION_EDGE_DECISION_IDS];

export const RELATION_ROLE_IDS = {
  unknown: "qr.rr.00000000",
  roleClass: "qr.rr.95b13f64",
  definitionClass: "qr.rr.1e7a6c02",
  contribution: "qr.rr.7d02e4a9",
  knownFor: "qr.rr.c86f2b10",
  characterCast: "qr.rr.2f41a8de",
  effect: "qr.rr.69a0dcb5",
  domain: "qr.rr.e3415f08",
  metadata: "qr.rr.a4d03b71",
  graphRequestRelation: "qr.rr.18e4c9a7",
  graphRequestMembership: "qr.rr.5f27b01c",
  graphCompactAttribute: "qr.rr.734cd82e",
  graphExplanatoryPath: "qr.rr.d9b60f43",
  graphCompoundMembership: "qr.rr.0c7a51ef",
  graphCompoundAttribute: "qr.rr.f2839a65",
  graphContextRelation: "qr.rr.46e2b7d0",
  graphContextBridge: "qr.rr.b8054c2a",
  graphNavigation: "qr.rr.3a91e67b"
} as const;

export type RelationRoleId = typeof RELATION_ROLE_IDS[keyof typeof RELATION_ROLE_IDS];

export const GRAPH_SLOT_IDS = {
  topicAnchor: "qr.gs.0f43a9c1",
  compactAttribute: "qr.gs.7a26d10e",
  requestAlignedRelation: "qr.gs.31f8c6a0",
  explanatoryPath: "qr.gs.b4d79e23",
  contextBridge: "qr.gs.e208a5f7",
  navigation: "qr.gs.5c04d8b2",
  contextRelation: "qr.gs.9f8e2d41"
} as const;

export type GraphSlotId = typeof GRAPH_SLOT_IDS[keyof typeof GRAPH_SLOT_IDS];

export const ANSWER_ROLE_IDS = {
  identity: "qr.ar.185e0c4a",
  contribution: "qr.ar.703a9d1f",
  significance: "qr.ar.c42f6b80",
  context: "qr.ar.29d8e4a7",
  field: "qr.ar.8f12b6d3",
  backgroundActor: "qr.ar.e06a3c91",
  backgroundRelation: "qr.ar.5b94f0e2",
  boundary: "qr.ar.d13c7a05"
} as const;

export type AnswerRoleId = typeof ANSWER_ROLE_IDS[keyof typeof ANSWER_ROLE_IDS];

export const ANSWER_ROLE_GROUPS = {
  required: [ANSWER_ROLE_IDS.identity, ANSWER_ROLE_IDS.contribution, ANSWER_ROLE_IDS.context],
  optional: [
    ANSWER_ROLE_IDS.significance,
    ANSWER_ROLE_IDS.field,
    ANSWER_ROLE_IDS.backgroundActor,
    ANSWER_ROLE_IDS.backgroundRelation,
    ANSWER_ROLE_IDS.boundary
  ],
  bridge: [ANSWER_ROLE_IDS.context, ANSWER_ROLE_IDS.significance, ANSWER_ROLE_IDS.field],
  background: [ANSWER_ROLE_IDS.backgroundActor, ANSWER_ROLE_IDS.backgroundRelation],
  selectionOrder: [
    ANSWER_ROLE_IDS.identity,
    ANSWER_ROLE_IDS.contribution,
    ANSWER_ROLE_IDS.significance,
    ANSWER_ROLE_IDS.context,
    ANSWER_ROLE_IDS.field
  ]
} as const;

export function isBridgeAnswerRoleId(roleId: string | undefined): boolean {
  return Boolean(roleId && (ANSWER_ROLE_GROUPS.bridge as readonly string[]).includes(roleId));
}

export function isBackgroundAnswerRoleId(roleId: string | undefined): boolean {
  return Boolean(roleId && (ANSWER_ROLE_GROUPS.background as readonly string[]).includes(roleId));
}

export const ANSWER_SLOT_IDS = {
  memberRelation: "qr.as.4c9b0e18",
  selectedSense: "qr.as.02d7a5f1",
  sensePrimary: "qr.as.6a23f5c1",
  senseLowValue: "qr.as.c0e41b73",
  sourceConcept: "qr.as.f17c82d0",
  targetConcept: "qr.as.9b5e4a6c",
  effectRelation: "qr.as.78d1f230",
  roleOrField: "qr.as.d0f6a948",
  contribution: "qr.as.2a7e90cb",
  context: "qr.as.e35c1a04",
  significance: "qr.as.b8f41d65",
  knownForContribution: "qr.as.a59d30e7",
  unsupportedSource: "qr.as.512c7e0d",
  profileExcerpt: "qr.as.f8e03b6a",
  navigationNoise: "qr.as.7c90d4e1",
  backgroundContext: "qr.as.3e5b1c09",
  alternateSense: "qr.as.96d0a7bc",
  secondaryMetadata: "qr.as.0d61e8fa",
  collectionLabelFragment: "qr.as.af42b7c3",
  collectionContext: "qr.as.1c87e6d4",
  requestMismatch: "qr.as.eab90315",
  lowQuestionValue: "qr.as.6f35ad02"
} as const;

export type AnswerSlotId = typeof ANSWER_SLOT_IDS[keyof typeof ANSWER_SLOT_IDS];

export const QUESTION_TYPE_IDS = {
  entity: "qr.qt.0d58a2f1",
  contribution: "qr.qt.a716c9e0",
  collectionMember: "qr.qt.5e42b1d8",
  senseDefinition: "qr.qt.c08f63a4",
  effectBridge: "qr.qt.91de2f06"
} as const;

export type QuestionTypeId = typeof QUESTION_TYPE_IDS[keyof typeof QUESTION_TYPE_IDS];

export const QUESTION_SHAPE_IDS = {
  compact: "qr.qs.19b4e0f7",
  narrow: "qr.qs.5c2a81d0",
  expanded: "qr.qs.e4067b9a",
  balanced: "qr.qs.82d3f6c1",
  none: "qr.qs.00000000"
} as const;

export type QuestionShapeKindId = typeof QUESTION_SHAPE_IDS[keyof typeof QUESTION_SHAPE_IDS];

export const QUESTION_SLOT_REASON_IDS = {
  forceRejected: "qr.qr.6c1b49e0",
  profileExcerpt: "qr.qr.49f8d23a",
  navigationNoise: "qr.qr.3b06c9e1",
  backgroundRole: "qr.qr.a0e45f72",
  senseMixed: "qr.qr.e8c12a60",
  metadata: "qr.qr.0f76b8d4",
  memberRequested: "qr.qr.7a4e1c0b",
  collectionFragment: "qr.qr.b36d08f5",
  memberMissing: "qr.qr.91c5e7a2",
  contributionPath: "qr.qr.c2804f69",
  roleField: "qr.qr.65d30b1e",
  significance: "qr.qr.f5029a8c",
  context: "qr.qr.24e8d6b0",
  effectRelation: "qr.qr.4d17f0e3",
  effectContext: "qr.qr.82b6a5d1",
  selectedSense: "qr.qr.e32b8a64",
  knownContribution: "qr.qr.13c4a70d",
  lowSlotValue: "qr.qr.95f2d0a1",
  topicFallback: "qr.qr.d20a6b4e",
  fabricSelection: "qr.qr.0a59c3f8",
  alternateSense: "qr.qr.2e8f41b6",
  partialSupport: "qr.qr.780f2d5a",
  coreFilled: "qr.qr.f41e0b27",
  requiredMissing: "qr.qr.5d67a0c3",
  typeEntity: "qr.qr.98e1c6a2",
  typeContribution: "qr.qr.40b7f29e",
  typeCollectionMember: "qr.qr.7d8c12b4",
  typeSenseDefinition: "qr.qr.d13e8f06",
  typeEffectBridge: "qr.qr.a204b9c7",
  shapeCompact: "qr.qr.0c8f1a9d",
  shapeNarrow: "qr.qr.4f2d7c81",
  shapeExpanded: "qr.qr.65b0a3e9",
  shapeBalanced: "qr.qr.9a5e2d40"
} as const;

export type QuestionSlotReasonId = typeof QUESTION_SLOT_REASON_IDS[keyof typeof QUESTION_SLOT_REASON_IDS];

export const QUESTION_TYPE_REASON_IDS: Record<QuestionTypeId, QuestionSlotReasonId> = {
  [QUESTION_TYPE_IDS.entity]: QUESTION_SLOT_REASON_IDS.typeEntity,
  [QUESTION_TYPE_IDS.contribution]: QUESTION_SLOT_REASON_IDS.typeContribution,
  [QUESTION_TYPE_IDS.collectionMember]: QUESTION_SLOT_REASON_IDS.typeCollectionMember,
  [QUESTION_TYPE_IDS.senseDefinition]: QUESTION_SLOT_REASON_IDS.typeSenseDefinition,
  [QUESTION_TYPE_IDS.effectBridge]: QUESTION_SLOT_REASON_IDS.typeEffectBridge
};

export const QUESTION_SHAPE_REASON_IDS: Record<QuestionShapeKindId, QuestionSlotReasonId> = {
  [QUESTION_SHAPE_IDS.compact]: QUESTION_SLOT_REASON_IDS.shapeCompact,
  [QUESTION_SHAPE_IDS.narrow]: QUESTION_SLOT_REASON_IDS.shapeNarrow,
  [QUESTION_SHAPE_IDS.expanded]: QUESTION_SLOT_REASON_IDS.shapeExpanded,
  [QUESTION_SHAPE_IDS.balanced]: QUESTION_SLOT_REASON_IDS.shapeBalanced,
  [QUESTION_SHAPE_IDS.none]: QUESTION_SLOT_REASON_IDS.shapeBalanced
};
