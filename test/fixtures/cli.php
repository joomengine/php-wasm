<?php
echo json_encode([
    'sapi' => PHP_SAPI,
    'version' => PHP_VERSION,
    'integer_size' => PHP_INT_SIZE,
    'integer_max' => PHP_INT_MAX,
    'args' => $argv,
    'argc' => $argc,
    'cwd' => getcwd(),
    'stdin' => stream_get_contents(STDIN),
    'extensions' => get_loaded_extensions(),
    'server' => array_intersect_key($_SERVER, array_flip(['PHP_SELF', 'SCRIPT_NAME', 'SCRIPT_FILENAME', 'PATH_TRANSLATED', 'DOCUMENT_ROOT'])),
], JSON_THROW_ON_ERROR);
fwrite(STDERR, "cli diagnostic\n");
