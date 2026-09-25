-- Security notices for unfamiliar sign-ins remain on for everyone. Routine
-- sign-in and sign-out messages are opt-in to avoid notification fatigue.
ALTER TABLE users ADD COLUMN email_every_login boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN email_on_logout boolean NOT NULL DEFAULT false;
