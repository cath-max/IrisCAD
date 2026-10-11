-- Global agent preferences on profiles (Settings → Agent).
-- Soft build-round cap, optional per-build Continue, optional chat seven-view thumbs.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS agent_max_build_rounds integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS agent_require_build_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_show_seven_view boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_agent_max_build_rounds_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_agent_max_build_rounds_check
  CHECK (agent_max_build_rounds >= 1 AND agent_max_build_rounds <= 40);

COMMENT ON COLUMN public.profiles.agent_max_build_rounds IS
  'Soft max parametric build rounds before auto-continue pauses (hard = min(soft*2, 80)).';
COMMENT ON COLUMN public.profiles.agent_require_build_approval IS
  'When true, each build_parametric_model run waits for user Continue.';
COMMENT ON COLUMN public.profiles.agent_show_seven_view IS
  'When true, show seven-view inspection thumbnails in chat (model still receives them either way).';
