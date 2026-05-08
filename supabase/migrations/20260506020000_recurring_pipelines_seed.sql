-- ============================================================
-- Recurring Service Tasks — Phase 2: Seed Pipelines
-- ============================================================
-- Five short pipelines used by the recurring scheduler.
-- All marked is_recurring = true so fn_match_pipeline_key
-- (rewritten in Phase 1) ignores them when matching onboarding
-- services entered on the client form.
--
-- Onboarding pipelines (home/vehicle/parental/legal) keep
-- is_recurring = false (column default).

insert into public.service_pipelines
  (pipeline_key, display_name, service_match_patterns, is_recurring, steps)
values
(
  'home_inspection',
  'Home Monthly Inspection',
  '{"inspection","property inspection","monthly inspection"}',
  true,
  '[
    {"name":"Property Visit","description":"On-site visit to inspect the property — exterior, interior, fixtures, society common areas.","required_skill":"Inspection"},
    {"name":"Inspection Report & Photos","description":"Upload condition report and dated photographs covering each room and any issues observed.","required_skill":"Inspection"}
  ]'::jsonb
),
(
  'home_maintenance',
  'Home Maintenance Visit',
  '{"maintenance","home maintenance"}',
  true,
  '[
    {"name":"Site Visit","description":"Visit the property to assess maintenance needs — plumbing, electrical, painting, pest, etc.","required_skill":"Property"},
    {"name":"Maintenance Report & Photos","description":"Document work performed (or quotes obtained) with before/after photos and vendor receipts.","required_skill":"Property"}
  ]'::jsonb
),
(
  'vehicle_servicing',
  'Vehicle Service Visit',
  '{"servicing","vehicle servicing"}',
  true,
  '[
    {"name":"Service Booking","description":"Book authorised service centre slot. Confirm pickup/drop logistics with client.","required_skill":"Vehicle"},
    {"name":"Service Completion & Bill","description":"Service completed. Upload itemised bill, jobcard, and post-service photos.","required_skill":"Vehicle"}
  ]'::jsonb
),
(
  'parental_checkup',
  'Parental Wellness Check',
  '{"wellbeing","health checkup","companion","wellness"}',
  true,
  '[
    {"name":"Visit Parent","description":"Companion visit — vitals, mood, medication adherence, household needs.","required_skill":"Care"},
    {"name":"Wellness Report","description":"Submit visit notes, photos with parent (where consented), and any escalations.","required_skill":"Care"}
  ]'::jsonb
),
(
  'medicine_delivery',
  'Medicine Delivery',
  '{"medicine","medicine delivery"}',
  true,
  '[
    {"name":"Pickup & Deliver","description":"Pick prescribed medicines from pharmacy and deliver to parent address.","required_skill":"Care"},
    {"name":"Delivery Confirmation Photo","description":"Photo of delivered medicines + signed/acknowledged receipt.","required_skill":"Care"}
  ]'::jsonb
)
on conflict (pipeline_key) do update set
  is_recurring = excluded.is_recurring,
  service_match_patterns = excluded.service_match_patterns,
  steps = excluded.steps,
  display_name = excluded.display_name;
