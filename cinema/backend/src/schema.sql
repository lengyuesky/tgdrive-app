-- 只属于影视应用；宿主不读取业务表。可再生图片通过宿主缓存 API 管理。
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS settings(
 id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL,
 username TEXT NOT NULL DEFAULT '', verifier TEXT NOT NULL DEFAULT '', running INTEGER NOT NULL DEFAULT 0,
 scope_revision TEXT NOT NULL DEFAULT '', change_cursor TEXT, index_revision TEXT NOT NULL,
 play_serial INTEGER NOT NULL DEFAULT 0, data_revision TEXT NOT NULL DEFAULT '', generation TEXT NOT NULL DEFAULT '', app_version TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS libraries(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('movie','tv')),root_id TEXT NOT NULL,position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,parent_id TEXT,path TEXT NOT NULL,kind TEXT NOT NULL,extension TEXT NOT NULL,name_key TEXT NOT NULL,document TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id,extension,id);
CREATE INDEX IF NOT EXISTS nodes_parent_name ON nodes(parent_id,name_key,id);
CREATE INDEX IF NOT EXISTS nodes_path ON nodes(path);
CREATE TABLE IF NOT EXISTS node_libraries(library_id TEXT NOT NULL,node_id TEXT NOT NULL,PRIMARY KEY(library_id,node_id));
CREATE INDEX IF NOT EXISTS node_membership ON node_libraries(node_id,library_id);
CREATE TABLE IF NOT EXISTS entries(node_id TEXT PRIMARY KEY,guid TEXT NOT NULL UNIQUE,media_guid TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,title TEXT NOT NULL,folded_title TEXT NOT NULL,added_at INTEGER NOT NULL,modified_at INTEGER NOT NULL,show_guid TEXT NOT NULL,season_guid TEXT NOT NULL,season INTEGER NOT NULL,episode INTEGER NOT NULL,document TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS entries_show ON entries(show_guid,season,episode,guid);
CREATE INDEX IF NOT EXISTS entries_season ON entries(season_guid,episode,guid);
CREATE TABLE IF NOT EXISTS entry_libraries(library_id TEXT NOT NULL,node_id TEXT NOT NULL,PRIMARY KEY(library_id,node_id));
CREATE INDEX IF NOT EXISTS entry_membership ON entry_libraries(node_id,library_id);
CREATE TABLE IF NOT EXISTS catalog(guid TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,folded_title TEXT NOT NULL,added_at INTEGER NOT NULL,modified_at INTEGER NOT NULL,parent_guid TEXT NOT NULL,show_guid TEXT NOT NULL,season INTEGER NOT NULL,episode INTEGER NOT NULL,document TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS catalog_title ON catalog(title,guid);
CREATE INDEX IF NOT EXISTS catalog_added_asc ON catalog(added_at,title,guid);
CREATE INDEX IF NOT EXISTS catalog_added_desc ON catalog(added_at DESC,title,guid);
CREATE INDEX IF NOT EXISTS catalog_parent_title ON catalog(parent_guid,title,guid);
CREATE INDEX IF NOT EXISTS catalog_parent_added ON catalog(parent_guid,added_at DESC,title,guid);
CREATE TABLE IF NOT EXISTS catalog_libraries(guid TEXT NOT NULL,library_id TEXT NOT NULL,PRIMARY KEY(library_id,guid));
CREATE INDEX IF NOT EXISTS catalog_membership ON catalog_libraries(guid,library_id);
CREATE TABLE IF NOT EXISTS progress(media_guid TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,document TEXT NOT NULL,revision TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS progress_recent ON progress(updated_at DESC,media_guid);
CREATE TABLE IF NOT EXISTS play_authority(media_guid TEXT PRIMARY KEY,serial INTEGER NOT NULL,started_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS flags(target TEXT PRIMARY KEY,favorite INTEGER NOT NULL DEFAULT 0,watched INTEGER,revision TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS flags_favorite ON flags(favorite,target);
CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,document TEXT NOT NULL,revision TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS probes(media_guid TEXT PRIMARY KEY,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cover_states(media_guid TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,state TEXT NOT NULL,cache_key TEXT,next_retry INTEGER NOT NULL DEFAULT 0,document TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS covers_queue ON cover_states(state,next_retry,media_guid);
CREATE INDEX IF NOT EXISTS covers_key ON cover_states(cache_key);
CREATE TABLE IF NOT EXISTS person_records(person_id TEXT NOT NULL,node_id TEXT NOT NULL,is_show INTEGER NOT NULL,position INTEGER NOT NULL,metadata_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(node_id,is_show,position));
CREATE INDEX IF NOT EXISTS person_works ON person_records(person_id,node_id);
CREATE TABLE IF NOT EXISTS attachments(guid TEXT NOT NULL,entry_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(guid,entry_id));
CREATE TABLE IF NOT EXISTS actor_records(key TEXT PRIMARY KEY,person_id TEXT NOT NULL,metadata_id TEXT NOT NULL,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scan_actor_refs(library_id TEXT NOT NULL,node_id TEXT NOT NULL,is_show INTEGER NOT NULL,position INTEGER NOT NULL,record_key TEXT NOT NULL,PRIMARY KEY(library_id,node_id,is_show,position));
CREATE TABLE IF NOT EXISTS person_images(key TEXT PRIMARY KEY,person_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scan_libraries(id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS scan_nodes(library_id TEXT NOT NULL,id TEXT NOT NULL,parent_id TEXT,path TEXT NOT NULL,kind TEXT NOT NULL,extension TEXT NOT NULL,name_key TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(library_id,id));
CREATE INDEX IF NOT EXISTS scan_related ON scan_nodes(library_id,parent_id,extension,id);
CREATE INDEX IF NOT EXISTS scan_paths ON scan_nodes(library_id,path);
CREATE TABLE IF NOT EXISTS scan_entries(library_id TEXT NOT NULL,node_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(library_id,node_id));
-- 主人页面的轻量业务修订只随真正的业务变化推进，宿主变更 checkpoint 不触发页面刷新。
CREATE TRIGGER IF NOT EXISTS progress_inserted AFTER INSERT ON progress BEGIN UPDATE settings SET data_revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS progress_updated AFTER UPDATE ON progress BEGIN UPDATE settings SET data_revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS progress_deleted AFTER DELETE ON progress BEGIN UPDATE settings SET data_revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS flags_inserted AFTER INSERT ON flags BEGIN UPDATE settings SET data_revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS flags_updated AFTER UPDATE ON flags BEGIN UPDATE settings SET data_revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS preferences_inserted AFTER INSERT ON preferences WHEN NEW.key NOT LIKE 'internal:%' BEGIN UPDATE settings SET data_revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS preferences_updated AFTER UPDATE ON preferences WHEN NEW.key NOT LIKE 'internal:%' BEGIN UPDATE settings SET data_revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS cover_inserted AFTER INSERT ON cover_states BEGIN UPDATE settings SET data_revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS cover_updated AFTER UPDATE ON cover_states BEGIN UPDATE settings SET data_revision=lower(hex(randomblob(16))) WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS cover_deleted AFTER DELETE ON cover_states BEGIN UPDATE settings SET data_revision=lower(hex(randomblob(16))) WHERE id=1; END;
PRAGMA user_version=1;
