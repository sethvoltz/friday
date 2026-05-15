/**
 * Minimal Linear GraphQL client. Uses `fetch` against `api.linear.app/graphql`
 * with the `LINEAR_API_KEY` env var. No SDK dep — Linear's GraphQL surface
 * is small for our needs (list active issues + lookup by identifier) and a
 * focused query keeps the bundle light.
 *
 * If field shapes drift on Linear's end, errors surface on first use; rerun
 * `reconcile()` after adjusting the queries here.
 */

const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[] }>;
}

export class LinearApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearApiError";
  }
}

export async function linearQuery<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LinearApiError(`Linear API ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new LinearApiError(
      `Linear GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!json.data) {
    throw new LinearApiError("Linear API returned no data");
  }
  return json.data;
}

export interface LinearIssue {
  id: string;
  identifier: string; // e.g. "FRI-42"
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  state: { name: string; type: LinearStateType };
}

export type LinearStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  updatedAt
  state { name type }
`;

/**
 * Paginate through every issue whose state-type is in `stateTypes`. Default
 * `["unstarted", "started"]` — the "active work" set.
 */
export async function listActiveIssues(opts: {
  apiKey: string;
  stateTypes?: LinearStateType[];
  pageSize?: number;
  maxPages?: number;
}): Promise<LinearIssue[]> {
  const stateTypes = opts.stateTypes ?? ["unstarted", "started"];
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 20; // 2000-issue ceiling — adjust if needed.

  interface IssuesQueryResult {
    issues: {
      nodes: LinearIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }
  const out: LinearIssue[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data: IssuesQueryResult = await linearQuery<IssuesQueryResult>(
      opts.apiKey,
      `query Issues($filter: IssueFilter, $first: Int, $after: String) {
         issues(filter: $filter, first: $first, after: $after) {
           nodes { ${ISSUE_FIELDS} }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      {
        filter: { state: { type: { in: stateTypes } } },
        first: pageSize,
        after,
      },
    );
    out.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) break;
    after = data.issues.pageInfo.endCursor;
    if (!after) break;
  }
  return out;
}

/**
 * Look up a single issue by Linear's `TEAM-N` identifier. Linear's GraphQL
 * doesn't expose this directly, so we filter on team key + number.
 */
export async function getIssueByIdentifier(opts: {
  apiKey: string;
  identifier: string; // "TEAM-42"
}): Promise<LinearIssue | null> {
  const m = opts.identifier.match(/^([A-Z][A-Z0-9_]*)-(\d+)$/);
  if (!m) return null;
  const [, teamKey, numStr] = m;
  const number = Number.parseInt(numStr, 10);

  interface IssueLookupResult {
    issues: { nodes: LinearIssue[] };
  }
  const data: IssueLookupResult = await linearQuery<IssueLookupResult>(
    opts.apiKey,
    `query Issue($filter: IssueFilter) {
       issues(filter: $filter, first: 1) {
         nodes { ${ISSUE_FIELDS} }
       }
     }`,
    {
      filter: {
        number: { eq: number },
        team: { key: { eq: teamKey } },
      },
    },
  );
  return data.issues.nodes[0] ?? null;
}

/**
 * Resolve a Linear workflow-state UUID for a given (team key, state type).
 * Linear allows multiple states per type (e.g., "Done" and "Released" both
 * `completed`); we return the first match, which is sufficient for archive
 * propagation.
 */
export async function getStateIdByType(opts: {
  apiKey: string;
  teamKey: string;
  stateType: LinearStateType;
}): Promise<string | null> {
  interface StatesResult {
    workflowStates: { nodes: Array<{ id: string; type: LinearStateType }> };
  }
  const data: StatesResult = await linearQuery<StatesResult>(
    opts.apiKey,
    `query States($filter: WorkflowStateFilter) {
       workflowStates(filter: $filter, first: 50) {
         nodes { id type }
       }
     }`,
    {
      filter: {
        team: { key: { eq: opts.teamKey } },
        type: { eq: opts.stateType },
      },
    },
  );
  return data.workflowStates.nodes[0]?.id ?? null;
}

/**
 * Move a Linear issue to the first workflow state matching `stateType` on its
 * team. Used by the daemon's ticket-close path when a Friday ticket has a
 * `system='linear'` external link and its agent is archived. One-way write
 * driven by Friday's authoritative local status (see ADR-006 amendment).
 */
export async function setIssueStateByType(opts: {
  apiKey: string;
  issueIdentifier: string; // "TEAM-42"
  stateType: LinearStateType;
}): Promise<void> {
  const m = opts.issueIdentifier.match(/^([A-Z][A-Z0-9_]*)-(\d+)$/);
  if (!m) {
    throw new LinearApiError(
      `Invalid Linear identifier: ${opts.issueIdentifier}`,
    );
  }
  const teamKey = m[1];

  const issue = await getIssueByIdentifier({
    apiKey: opts.apiKey,
    identifier: opts.issueIdentifier,
  });
  if (!issue) {
    throw new LinearApiError(
      `Linear issue not found: ${opts.issueIdentifier}`,
    );
  }
  const stateId = await getStateIdByType({
    apiKey: opts.apiKey,
    teamKey,
    stateType: opts.stateType,
  });
  if (!stateId) {
    throw new LinearApiError(
      `No Linear workflow state of type "${opts.stateType}" on team "${teamKey}"`,
    );
  }

  interface UpdateResult {
    issueUpdate: { success: boolean };
  }
  const data: UpdateResult = await linearQuery<UpdateResult>(
    opts.apiKey,
    `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
       issueUpdate(id: $id, input: $input) {
         success
       }
     }`,
    {
      id: issue.id,
      input: { stateId },
    },
  );
  if (!data.issueUpdate.success) {
    throw new LinearApiError(
      `Linear issueUpdate returned success=false for ${opts.issueIdentifier}`,
    );
  }
}
