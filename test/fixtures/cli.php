<?php
echo json_encode([
    'sapi' => PHP_SAPI,
    'version' => PHP_VERSION,
    'args' => $argv,
    'argc' => $argc,
    'cwd' => getcwd(),
    'stdin' => stream_get_contents(STDIN),
    'extensions' => get_loaded_extensions(),
], JSON_THROW_ON_ERROR);
fwrite(STDERR, "cli diagnostic\n");
