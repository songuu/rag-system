alter table public.prompt_optimizer_model_profiles add column credential_envelope text;
alter table public.prompt_optimizer_model_profiles add constraint prompt_optimizer_model_profiles_credential_envelope_check check (credential_envelope is null or (length(credential_envelope) between 20 and 8192 and credential_envelope like 'v1.%'));
comment on column public.prompt_optimizer_model_profiles.credential_envelope is 'AES-256-GCM envelope; plaintext credentials must never be stored or returned by APIs.';
