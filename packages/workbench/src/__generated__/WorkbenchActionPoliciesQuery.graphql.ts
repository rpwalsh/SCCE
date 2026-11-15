/**
 * @generated SignedSource<<39eed1927256f193e135f03dd61d25fe>>
 * @lightSyntaxTransform
 */

/* tslint:disable */
/* eslint-disable */
// @ts-nocheck

import { ConcreteRequest } from 'relay-runtime';
export type WorkbenchActionPoliciesQuery$variables = Record<PropertyKey, never>;
export type WorkbenchActionPoliciesQuery$data = {
  readonly vscodeWorkspaceStatus: {
    readonly workspace: {
      readonly actionPolicies: ReadonlyArray<{
        readonly available: boolean;
        readonly context: {
          readonly expectedWorkspaceUpdatedAt: number;
          readonly policyId: string;
          readonly schema: string;
          readonly workspaceId: string;
        } | null | undefined;
        readonly policy: {
          readonly capabilityIds: ReadonlyArray<string>;
          readonly checks: ReadonlyArray<{
            readonly argv: ReadonlyArray<string>;
            readonly cwd: string;
            readonly executable: string;
            readonly executableSha256: string;
          }>;
          readonly maxCalls: number;
          readonly maxFileBytes: number;
          readonly maxOutputBytes: number;
          readonly maxWorkspaceBytes: number;
          readonly maxWorkspaceFiles: number;
          readonly protectedFiles: ReadonlyArray<{
            readonly path: string;
            readonly sha256: string;
          }>;
          readonly readablePaths: ReadonlyArray<string>;
          readonly timeoutMs: number;
          readonly writablePaths: ReadonlyArray<string>;
        };
        readonly policyId: string;
        readonly remainingCalls: number;
        readonly unavailableReason: string | null | undefined;
      }>;
      readonly id: string;
      readonly rootPath: string;
    } | null | undefined;
  };
};
export type WorkbenchActionPoliciesQuery = {
  response: WorkbenchActionPoliciesQuery$data;
  variables: WorkbenchActionPoliciesQuery$variables;
};

const node: ConcreteRequest = (function(){
var v0 = {
  "alias": null,
  "args": null,
  "kind": "ScalarField",
  "name": "policyId",
  "storageKey": null
},
v1 = [
  {
    "alias": null,
    "args": null,
    "concreteType": "VscodeWorkspaceStatusResult",
    "kind": "LinkedField",
    "name": "vscodeWorkspaceStatus",
    "plural": false,
    "selections": [
      {
        "alias": null,
        "args": null,
        "concreteType": "VscodeWorkspace",
        "kind": "LinkedField",
        "name": "workspace",
        "plural": false,
        "selections": [
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "id",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "kind": "ScalarField",
            "name": "rootPath",
            "storageKey": null
          },
          {
            "alias": null,
            "args": null,
            "concreteType": "RegisteredWorkspaceActionPolicy",
            "kind": "LinkedField",
            "name": "actionPolicies",
            "plural": true,
            "selections": [
              (v0/*:: as any*/),
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "available",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "unavailableReason",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "kind": "ScalarField",
                "name": "remainingCalls",
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "concreteType": "WorkspaceActionContext",
                "kind": "LinkedField",
                "name": "context",
                "plural": false,
                "selections": [
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "schema",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "workspaceId",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "expectedWorkspaceUpdatedAt",
                    "storageKey": null
                  },
                  (v0/*:: as any*/)
                ],
                "storageKey": null
              },
              {
                "alias": null,
                "args": null,
                "concreteType": "WorkspaceActionPolicy",
                "kind": "LinkedField",
                "name": "policy",
                "plural": false,
                "selections": [
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "capabilityIds",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "readablePaths",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "writablePaths",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "concreteType": "WorkspaceActionProtectedFile",
                    "kind": "LinkedField",
                    "name": "protectedFiles",
                    "plural": true,
                    "selections": [
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
                        "name": "sha256",
                        "storageKey": null
                      }
                    ],
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "concreteType": "WorkspaceActionCheck",
                    "kind": "LinkedField",
                    "name": "checks",
                    "plural": true,
                    "selections": [
                      {
                        "alias": null,
                        "args": null,
                        "kind": "ScalarField",
                        "name": "executable",
                        "storageKey": null
                      },
                      {
                        "alias": null,
                        "args": null,
                        "kind": "ScalarField",
                        "name": "executableSha256",
                        "storageKey": null
                      },
                      {
                        "alias": null,
                        "args": null,
                        "kind": "ScalarField",
                        "name": "argv",
                        "storageKey": null
                      },
                      {
                        "alias": null,
                        "args": null,
                        "kind": "ScalarField",
                        "name": "cwd",
                        "storageKey": null
                      }
                    ],
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "maxFileBytes",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "maxWorkspaceFiles",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "maxWorkspaceBytes",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "timeoutMs",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "maxOutputBytes",
                    "storageKey": null
                  },
                  {
                    "alias": null,
                    "args": null,
                    "kind": "ScalarField",
                    "name": "maxCalls",
                    "storageKey": null
                  }
                ],
                "storageKey": null
              }
            ],
            "storageKey": null
          }
        ],
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
    "name": "WorkbenchActionPoliciesQuery",
    "selections": (v1/*:: as any*/),
    "type": "Query",
    "abstractKey": null
  },
  "kind": "Request",
  "operation": {
    "argumentDefinitions": [],
    "kind": "Operation",
    "name": "WorkbenchActionPoliciesQuery",
    "selections": (v1/*:: as any*/)
  },
  "params": {
    "cacheID": "f76e535b04360e736efb0e85e2e77b89",
    "id": null,
    "metadata": {},
    "name": "WorkbenchActionPoliciesQuery",
    "operationKind": "query",
    "text": "query WorkbenchActionPoliciesQuery {\n  vscodeWorkspaceStatus {\n    workspace {\n      id\n      rootPath\n      actionPolicies {\n        policyId\n        available\n        unavailableReason\n        remainingCalls\n        context {\n          schema\n          workspaceId\n          expectedWorkspaceUpdatedAt\n          policyId\n        }\n        policy {\n          capabilityIds\n          readablePaths\n          writablePaths\n          protectedFiles {\n            path\n            sha256\n          }\n          checks {\n            executable\n            executableSha256\n            argv\n            cwd\n          }\n          maxFileBytes\n          maxWorkspaceFiles\n          maxWorkspaceBytes\n          timeoutMs\n          maxOutputBytes\n          maxCalls\n        }\n      }\n    }\n  }\n}\n"
  }
};
})();

(node as any).hash = "057545d54fede747d4fdda8ca861172d";

export default node;
