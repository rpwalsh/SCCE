import type {
  InformationAccessContext,
  InformationExportClass,
  InformationLabel,
  InformationMergePolicy,
  JsonValue
} from "./types.js";

const EXPORT_CLASS_RANK: Record<InformationExportClass, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3
};

const MERGE_POLICY_RANK: Record<InformationMergePolicy, number> = {
  same_owner: 0,
  explicit: 1,
  isolated: 2
};

export function normalizeInformationLabel(label: InformationLabel): InformationLabel {
  const tenantId = label.tenantId.normalize("NFKC").trim();
  if (!tenantId) throw new Error("information label requires tenantId");
  const principals = normalizedIdentities(label.principals);
  if (!principals.length && label.exportClass !== "public") {
    throw new Error("non-public information label requires at least one principal");
  }
  return {
    tenantId,
    principals,
    compartments: normalizedIdentities(label.compartments),
    exportClass: label.exportClass,
    mergePolicy: label.mergePolicy
  };
}

export function informationLabelAllowsRead(
  labelInput: InformationLabel,
  accessInput: InformationAccessContext
): boolean {
  const label = normalizeInformationLabel(labelInput);
  const tenantId = accessInput.tenantId.normalize("NFKC").trim();
  const principalId = accessInput.principalId.normalize("NFKC").trim();
  if (!tenantId || !principalId) return false;
  if (label.exportClass !== "public" && label.tenantId !== tenantId) return false;
  if (EXPORT_CLASS_RANK[label.exportClass] > EXPORT_CLASS_RANK[accessInput.maximumExportClass]) return false;
  if (label.principals.length && !label.principals.includes(principalId)) return false;
  const compartments = new Set(normalizedIdentities(accessInput.compartments));
  return label.compartments.every(compartment => compartments.has(compartment));
}

export function joinInformationLabels(
  inputs: readonly InformationLabel[],
  options: { explicitMergeAuthority?: boolean } = {}
): InformationLabel {
  if (!inputs.length) throw new Error("information label join requires at least one input");
  const labels = inputs.map(normalizeInformationLabel);
  const tenantIds = new Set(labels.map(label => label.tenantId));
  if (tenantIds.size !== 1) throw new Error("cross-tenant information merge denied");
  if (
    labels.some(label => label.mergePolicy === "isolated")
    && !sameIdentityBoundary(labels)
  ) {
    throw new Error("isolated information merge denied");
  }
  if (
    labels.some(label => label.mergePolicy === "explicit")
    && options.explicitMergeAuthority !== true
  ) {
    throw new Error("explicit information merge authority required");
  }
  const restrictedPrincipals = labels
    .map(label => label.principals)
    .filter(principals => principals.length > 0);
  const principals = restrictedPrincipals.length
    ? restrictedPrincipals.slice(1).reduce(
      (intersection, current) => intersection.filter(principal => current.includes(principal)),
      [...restrictedPrincipals[0]!]
    )
    : [];
  const exportClass = labels.reduce(
    (mostRestricted, label) => EXPORT_CLASS_RANK[label.exportClass] > EXPORT_CLASS_RANK[mostRestricted]
      ? label.exportClass
      : mostRestricted,
    "public" as InformationExportClass
  );
  if (!principals.length && exportClass !== "public") {
    throw new Error("information merge has no jointly authorized principal");
  }
  return {
    tenantId: labels[0]!.tenantId,
    principals,
    compartments: normalizedIdentities(labels.flatMap(label => label.compartments)),
    exportClass,
    mergePolicy: labels.reduce(
      (mostRestrictive, label) => MERGE_POLICY_RANK[label.mergePolicy] > MERGE_POLICY_RANK[mostRestrictive]
        ? label.mergePolicy
        : mostRestrictive,
      "same_owner" as InformationMergePolicy
    )
  };
}

export function informationLabelAudit(label: InformationLabel): JsonValue {
  const normalized = normalizeInformationLabel(label);
  return {
    schema: "scce.information_label.v1",
    tenantId: normalized.tenantId,
    principals: normalized.principals,
    compartments: normalized.compartments,
    exportClass: normalized.exportClass,
    mergePolicy: normalized.mergePolicy
  };
}

function sameIdentityBoundary(labels: readonly InformationLabel[]): boolean {
  const first = labels[0]!;
  return labels.every(label =>
    label.tenantId === first.tenantId
    && equalArrays(label.principals, first.principals)
    && equalArrays(label.compartments, first.compartments)
  );
}

function normalizedIdentities(values: readonly string[]): string[] {
  return [...new Set(values
    .map(value => value.normalize("NFKC").trim())
    .filter(Boolean))]
    .sort();
}

function equalArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
