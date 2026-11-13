-- Catchmind answers are now written by the drawer and saved when the drawing is
-- published; a draft round has an empty word until then. The server no longer
-- reserves prompts from the shared word list, so stop copying round words into
-- catchmind_used_words. The table and its rows stay as a record of past prompts.
DROP TRIGGER IF EXISTS catchmind_word_insert;
DROP TRIGGER IF EXISTS catchmind_word_update;
