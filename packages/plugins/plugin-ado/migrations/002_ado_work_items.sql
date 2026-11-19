-- Backlog view: the plugin's cache of the project's ADO work items (doc/plans/2026-11-17-backlog-view.md).
-- Written by every live event, catch-up and full sync (never to an older rev); read by the backlog data.
CREATE TABLE plugin_ado_3dc5cc6a90.ado_work_items (
  company_id uuid NOT NULL,
  org text NOT NULL,
  project text NOT NULL,
  work_item_id integer NOT NULL,
  parent_id integer,
  work_item_type text NOT NULL DEFAULT '',
  type_color text,
  title text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT '',
  state_category text,
  stack_rank double precision,
  url text NOT NULL,
  rev integer NOT NULL DEFAULT 0,
  changed_date timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, org, project, work_item_id)
);
