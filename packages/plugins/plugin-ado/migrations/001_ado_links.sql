-- A2: the link between a task and its ADO work item (doc/plans/2026-11-14-ado-integration.md, decision 6).
-- The schema name is derived by the host from the plugin id and namespaceSlug "ado".
CREATE TABLE plugin_ado_3dc5cc6a90.ado_links (
  issue_id uuid PRIMARY KEY REFERENCES public.issues(id) ON DELETE CASCADE,
  company_id uuid NOT NULL,
  org text NOT NULL,
  project text NOT NULL,
  work_item_id integer NOT NULL,
  work_item_type text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  url text NOT NULL,
  rev integer NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now(),
  missing_at timestamptz,
  linked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, org, project, work_item_id)
);
