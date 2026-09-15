-- The role the API actually connects as.
--
-- Everything up to here runs as the RDS master user, which can drop any table
-- in the database. The API has no business being able to do that, and the audit
-- log has to be genuinely append-only rather than append-only by convention —
-- so the application gets its own role with exactly the rights it needs.
--
-- This migration is idempotent and safe to re-run: the password is set only if
-- the role does not already exist, so re-applying does not reset a credential
-- somebody is currently using.
--
-- After running this, put the iydani_app password into Secrets Manager and
-- point the Lambda at it. Until then the API connects as master and the audit
-- guarantee below is not in force — which is fine for a dev stack and is not
-- fine for real data.

do $$
begin
  if not exists (select from pg_roles where rolname = 'iydani_app') then
    -- Placeholder. Rotate immediately with:
    --   alter role iydani_app with password '<from secrets manager>';
    execute 'create role iydani_app with login password ' || quote_literal(gen_random_uuid()::text);
  end if;
end
$$;

grant connect on database iydani to iydani_app;
grant usage on schema public to iydani_app;

grant select, insert, update, delete on all tables in schema public to iydani_app;
grant usage, select on all sequences in schema public to iydani_app;

alter default privileges in schema public
  grant select, insert, update, delete on tables to iydani_app;

alter default privileges in schema public
  grant usage, select on sequences to iydani_app;

-- The exception, and the whole reason this file exists. Revoked AFTER the
-- blanket grant above, so the order here is load-bearing.
revoke update, delete, truncate on audit_logs from iydani_app;

alter default privileges in schema public
  revoke update, delete on tables from iydani_app;

-- ...but that last default-privileges revoke would also strip UPDATE from every
-- future table, so grant it back explicitly for the tables that need it. New
-- tables must be added here — which is deliberate friction: a table the API can
-- rewrite should be a decision somebody made, not a default.
grant update, delete on users to iydani_app;
