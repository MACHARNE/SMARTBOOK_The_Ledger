-- Auth scans these fields as strings. Legacy/directly inserted users with NULL
-- values can break email lookup, admin listing, and invitations.
-- Preserve every populated token and all existing identities and passwords.
-- https://supabase.com/docs/guides/troubleshooting/database-error-saving-new-user-RU_EwB
update auth.users
set recovery_token = coalesce(recovery_token, ''),
    email_change_token_new = coalesce(email_change_token_new, ''),
    email_change = coalesce(email_change, '')
where recovery_token is null
   or email_change_token_new is null
   or email_change is null;
