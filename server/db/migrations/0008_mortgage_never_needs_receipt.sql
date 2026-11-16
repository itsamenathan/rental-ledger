-- Mortgage payments (Schedule E line 12) never need a receipt; the tax report already skipped them.
UPDATE `categories` SET `receipt_policy` = 'never' WHERE `schedule_e_line` = '12';
