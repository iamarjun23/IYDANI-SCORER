-- Accounts, and the record of what was done to them.
--
-- Adapted from docs/roadmap/DATABASE-SCHEMA.md's User and AuditLog models, with
-- one structural change: there is no password_hash and no mfa_secret. Cognito
-- holds credentials (infra/terraform/cognito.tf); this table holds everything
-- about a person that is IYDANI's business rather than an auth provider's. The
-- link between the two is cognito_sub, which is the `sub` claim on every token
-- and is immutable for the life of the account — an email address is not, which
-- is why the join is not on email.

create type user_role as enum ('LEARNER', 'TEACHER', 'ADMIN');

create table users (
  id                   uuid primary key default gen_random_uuid(),

  -- The Cognito `sub` claim. Unique and NOT NULL: a row here without one is a
  -- user nobody can ever log in as.
  cognito_sub          text        not null unique,

  email                text        not null,
  display_name         text        not null,
  avatar_url           text,
  bio                  text,

  role                 user_role   not null default 'LEARNER',

  -- Set on first login from the client's own Intl.DateTimeFormat(). Everything
  -- scheduling-related is stored UTC and displayed through this.
  timezone             text,
  geo_region           text,

  -- null until the onboarding wizard is finished, which is how "is this a brand
  -- new account" is answered without a second flag that can disagree with it.
  onboarded_at         timestamptz,

  razorpay_customer_id text unique,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Soft delete. A booking, a review and an audit entry all point at a user,
  -- and a hard delete would either cascade through somebody else's history or
  -- fail outright.
  deleted_at           timestamptz
);

-- Email is unique among LIVE accounts only. A hard unique constraint would mean
-- a person who deletes their account can never register again with the same
-- address, which is not what deletion is supposed to cost them. Case-insensitive
-- because nobody thinks of Ravi@x.com and ravi@x.com as two people.
create unique index users_email_live_idx
  on users (lower(email))
  where deleted_at is null;

create index users_role_idx on users (role) where deleted_at is null;

-- One trigger rather than an updated_at written by every caller: a caller that
-- forgets is a row whose timestamp quietly lies, and there is no way to tell
-- afterwards which rows those were.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- INSERT and SELECT only, forever. The roadmap's point stands: an audit trail
-- the application can edit is an audit trail that proves nothing after the
-- application is compromised. The guarantee is enforced by GRANTs on the role
-- the API connects as (see migrations/002_app_role.sql), not by convention.
create table audit_logs (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        references users (id) on delete set null,
  action     text        not null,
  metadata   jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index audit_logs_user_idx   on audit_logs (user_id, created_at desc);
create index audit_logs_action_idx on audit_logs (action, created_at desc);
