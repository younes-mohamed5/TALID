
-- TALID: Secure webhook inbox for EasyOrders
-- Migration 0002

create table if not exists public.talid_webhook_events (
    id uuid primary key default gen_random_uuid(),

    provider text not null default 'easyorders',
    event_type text not null
        check (event_type in ('orders', 'order-status-update')),

    event_key text not null,
    external_order_id text,

    payload jsonb not null,

    processing_status text not null default 'received'
        check (
            processing_status in (
                'received',
                'processing',
                'processed',
                'failed',
                'ignored'
            )
        ),

    attempts integer not null default 0,
    last_error text,

    received_at timestamptz not null default now(),
    last_attempt_at timestamptz,
    processed_at timestamptz,

    constraint talid_webhook_provider_event_unique
        unique (provider, event_key)
);

create index if not exists idx_talid_webhook_events_status
    on public.talid_webhook_events
    (processing_status, received_at);

create index if not exists idx_talid_webhook_events_order
    on public.talid_webhook_events
    (external_order_id);

create index if not exists idx_talid_webhook_events_received
    on public.talid_webhook_events (received_at desc);

-- Protect customer and order payloads.
alter table public.talid_webhook_events
    enable row level security;

revoke all on public.talid_webhook_events
    from anon, authenticated;

grant all on public.talid_webhook_events
    to service_role;

comment on table public.talid_webhook_events is
    'Private inbox for verified TALID EasyOrders webhook events';
