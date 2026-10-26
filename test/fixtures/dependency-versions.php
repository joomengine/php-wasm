<?php
ob_start();
phpinfo(INFO_MODULES);
$info = ob_get_clean();
$row = static function (string $name) use ($info): ?string {
    preg_match('/^' . preg_quote($name, '/') . ' => (.*)$/m', $info, $matches);
    return isset($matches[1]) ? trim($matches[1]) : null;
};

echo json_encode([
    'openssl_headers' => OPENSSL_VERSION_TEXT,
    'openssl_loaded' => $row('OpenSSL Library Version'),
    'libxml_headers' => LIBXML_DOTTED_VERSION,
    'libxml_loaded' => LIBXML_LOADED_VERSION,
    // PHP's bundled GD reports PNG_LIBPNG_VER_STRING from its compiled headers.
    'libpng_headers' => $row('libPNG Version'),
    'zlib_headers' => ZLIB_VERSION,
    'zlib_loaded' => $row('Linked Version'),
    'libzip_headers' => ZipArchive::LIBZIP_VERSION,
    'libzip_loaded' => $row('Libzip library version') ?? $row('Libzip version'),
    'icu' => INTL_ICU_VERSION,
    'oniguruma' => MB_ONIGURUMA_VERSION,
], JSON_THROW_ON_ERROR);
