-- First-run seed for Infisical service
-- Note: This runs only when PGDATA is empty (initial init).

-- Create dedicated role for Infisical
CREATE ROLE infisical LOGIN PASSWORD 'infisical_secret';

-- Create dedicated database owned by Infisical
CREATE DATABASE infisical OWNER infisical;

-- Ensure the default schema exists and is owned by Infisical
\connect infisical
CREATE SCHEMA IF NOT EXISTS public AUTHORIZATION infisical;
ALTER SCHEMA public OWNER TO infisical;

-- Optional: Grant privileges on future objects in public schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO infisical;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO infisical;
