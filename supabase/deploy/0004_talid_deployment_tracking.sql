-- TALID deployment tracking (additive and safe to re-run)
create table if not exists public.talid_deployments (
  id bigint generated always as identity primary key,
  commit_sha text not null unique,
  branch_name text not null,
  workflow_run_id text not null,
  deployed_by text not null default 'github-actions',
  deployed_at timestamptz not null default now()
);

alter table public.talid_deployments enable row level security;
revoke all on public.talid_deployments from anon, authenticated;
grant all on public.talid_deployments to service_role;

insert into public.talid_deployments
  (commit_sha, branch_name, workflow_run_id, deployed_by, deployed_at)
values
  (:'commit_sha', :'branch_name', :'workflow_run_id', 'github-actions', now())
on conflict (commit_sha) do update
set branch_name = excluded.branch_name,
    workflow_run_id = excluded.workflow_run_id,
    deployed_by = excluded.deployed_by,
    deployed_at = excluded.deployed_at;
