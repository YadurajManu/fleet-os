ALTER TABLE nodes ADD COLUMN build_disk_reserve_bytes bigint NOT NULL DEFAULT 0 CHECK (build_disk_reserve_bytes >= 0);
ALTER TABLE nodes ADD COLUMN build_disk_bytes bigint NOT NULL DEFAULT 21474836480 CHECK (build_disk_bytes >= 1073741824);
