/**
 * @generated SignedSource<<5767816ace5a6cab1cea0bc8b877707c>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type WorkbenchCapabilitiesQuery$variables = Record<PropertyKey, never>;
export type WorkbenchCapabilitiesQuery$data = {
  readonly vscodeCodeValidationPolicies: {
    readonly policies: ReadonlyArray<{
      readonly checks: ReadonlyArray<string>;
      readonly id: string;
    }>;
    readonly provider: string;
  };
  readonly vscodeModels: {
    readonly modelDir: string;
    readonly models: ReadonlyArray<{
      readonly active: boolean;
      readonly bytes: number;
      readonly files: number;
      readonly id: string;
      readonly path: string;
      readonly size: string;
    }>;
    readonly schema: string;
    readonly totalBytes: number;
  };
  readonly vscodeSettings: {
    readonly configPath: string;
    readonly fields: ReadonlyArray<{
      readonly choices: ReadonlyArray<string> | null | undefined;
      readonly key: string;
      readonly kind: string;
      readonly label: string;
      readonly value: any | null | undefined;
    }>;
    readonly schema: string;
  };
};
export type WorkbenchCapabilitiesQuery = {
  response: WorkbenchCapabilitiesQuery$data;
  variables: WorkbenchCapabilitiesQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "schema",
  "storageKey": null
},
v1 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "id",
  "storageKey": null
},
v2 = [
  {
    "alias": null,
    "args": null,
    "concreteType": "VscodeSettingsResult",
    "kind": "LinkedField",
    "name": "vscodeSettings",
    "plural": false,
    "selections": [
      (v0/*:: as any*/),
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "configPath",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeSettingField",
        "kind": "LinkedField",
        "name": "fields",
        "plural": true,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "key",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "label",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "kind",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "choices",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "value",
            "storageKey": null
          }
        ],
        "storageKey": null
      }
    ],
    "storageKey": null
  },
  {
    "alias": null,
    "args": null,
    "concreteType": "VscodeModelsResult",
    "kind": "LinkedField",
    "name": "vscodeModels",
    "plural": false,
    "selections": [
      (v0/*:: as any*/),
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "modelDir",
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeModel",
        "kind": "LinkedField",
        "name": "models",
        "plural": true,
        "selections": [
          (v1/*:: as any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "path",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "bytes",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "files",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "active",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "size",
            "storageKey": null
          }
        ],
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "totalBytes",
        "storageKey": null
      }
    ],
    "storageKey": null
  },
  {
    "alias": null,
    "args": null,
    "concreteType": "VscodeCodeValidationPoliciesResult",
    "kind": "LinkedField",
    "name": "vscodeCodeValidationPolicies",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeCodeValidationPolicy",
        "kind": "LinkedField",
        "name": "policies",
        "plural": true,
        "selections": [
          (v1/*:: as any*/),
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "checks",
            "storageKey": null
          }
        ],
        "storageKey": null
      },
      {
        "alias": null,
        "args": null,
        "kind": "ScalarField",
        "name": "provider",
        "storageKey": null
      }
    ],
    "storageKey": null
  }
];
return {
  "fragment": {
    "argumentDefinitions": [],
    "kind": "Fragment",
    "metadata": null,
    "name": "WorkbenchCapabilitiesQuery",
    "selections": (v2/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "WorkbenchCapabilitiesQuery",
    "selections": (v2/*:: as any*/)
  },
  "params": {
    "cacheID": "3848932664c02ef931b7fb1f1c20fba9",
    "id": null,
    "metadata": {},
    "name": "WorkbenchCapabilitiesQuery",
    "operationKind": "query",
    "text": "query WorkbenchCapabilitiesQuery {\n  vscodeSettings {\n    schema\n    configPath\n    fields {\n      key\n      label\n      kind\n      choices\n      value\n    }\n  }\n  vscodeModels {\n    schema\n    modelDir\n    models {\n      id\n      path\n      bytes\n      files\n      active\n      size\n    }\n    totalBytes\n  }\n  vscodeCodeValidationPolicies {\n    policies {\n      id\n      checks\n    }\n    provider\n  }\n}\n"
  }
};
})();

(node as any).hash = "d16c7a08d03c661116c36201862b523c";

export default node;
