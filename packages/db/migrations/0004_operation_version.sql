-- The taxonomy version an operation claimed is a number, and the version table
-- holds it as one. A text column cannot be ordered or joined against it, which
-- is exactly what an integrity check comparing the two has to do.
ALTER TABLE "operations"
	ALTER COLUMN "taxonomy_version" TYPE bigint USING NULLIF("taxonomy_version", '')::bigint;
