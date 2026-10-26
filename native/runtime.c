/* SPDX-License-Identifier: Apache-2.0
 * A browser host SAPI. Each invocation has its own PHP process lifecycle;
 * Emscripten's filesystem and the host bridge remain attached to the module.
 */
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>
#include "php.h"
#include "php_main.h"
#include "php_variables.h"
#include "php_ini.h"
#include "php_streams.h"
#include "SAPI.h"
#include "zend_exceptions.h"
#include "zend_signal.h"

static size_t body_offset;
static zval *server_variables;
static int running;

EMSCRIPTEN_KEEPALIVE int php_wasm_abi_version(void) { return 1; }
EMSCRIPTEN_KEEPALIVE const char *php_wasm_version(void) { return PHP_VERSION; }

EM_JS(char *, host_string, (const char *key), {
    const value = Module.phpWasm.request[UTF8ToString(key)] ?? '';
    const size = lengthBytesUTF8(String(value)) + 1;
    const result = _malloc(size);
    if (!result) return 0;
    stringToUTF8(String(value), result, size);
    return result;
});
EM_JS(size_t, host_body_length, (), {
    return Module.phpWasm.request.body?.byteLength ?? 0;
});
EM_JS(size_t, host_read_body, (char *buffer, size_t length, size_t offset), {
    const body = Module.phpWasm.request.body ?? new Uint8Array();
    const count = Math.min(length, Math.max(0, body.byteLength - offset));
    HEAPU8.set(body.subarray(offset, offset + count), buffer);
    return count;
});
EM_JS(void, host_stdout, (const char *buffer, size_t length), {
    Module.phpWasm.onStdout(HEAPU8.slice(buffer, buffer + length));
});
EM_JS(void, host_stderr, (const char *message), {
    Module.phpWasm.onStderr(UTF8ToString(message) + '\n');
});
EM_JS(void, host_headers_begin, (int status), {
    Module.phpWasm.responseHeaders = [];
    Module.phpWasm.responseStatus = status;
});
EM_JS(void, host_header, (const char *header), {
    Module.phpWasm.responseHeaders.push(UTF8ToString(header));
});
EM_JS(void, host_headers_end, (), {
    Module.phpWasm.onHeaders(Module.phpWasm.responseStatus, Module.phpWasm.responseHeaders);
});

EMSCRIPTEN_KEEPALIVE void php_wasm_add_server_variable(const char *name, const char *value)
{
    if (server_variables) php_register_variable(name, value, server_variables);
}
EM_JS(void, host_server_variables, (), {
    for (const [name, value] of Object.entries(Module.phpWasm.request.server ?? {})) {
        const n = lengthBytesUTF8(name) + 1;
        const v = lengthBytesUTF8(String(value)) + 1;
        const np = _malloc(n), vp = _malloc(v);
        if (!np || !vp) { if (np) _free(np); if (vp) _free(vp); throw new Error('Unable to allocate server variables'); }
        try {
            stringToUTF8(name, np, n); stringToUTF8(String(value), vp, v);
            _php_wasm_add_server_variable(np, vp);
        } finally { _free(np); _free(vp); }
    }
});

EMSCRIPTEN_KEEPALIVE int php_wasm_setenv(const char *name, const char *value)
{
    return setenv(name, value, 1);
}
EM_JS(int, host_environment, (), {
    for (const [name, value] of Object.entries(Module.phpWasm.request.env ?? {})) {
        const text = String(value);
        const n = lengthBytesUTF8(name) + 1, v = lengthBytesUTF8(text) + 1;
        const np = _malloc(n), vp = _malloc(v);
        if (!np || !vp) { _free(np); _free(vp); return 0; }
        try {
            stringToUTF8(name, np, n); stringToUTF8(text, vp, v);
            if (_php_wasm_setenv(np, vp) !== 0) return 0;
        } finally { _free(np); _free(vp); }
    }
    return 1;
});

/* Errors are returned to PHP, rather than throwing through the Asyncify stack. */
EM_ASYNC_JS(char *, host_call, (const char *name, const char *payload, int *failed), {
    let value;
    try {
        if (typeof Module.phpWasm.hostCall !== 'function') throw new Error('No host bridge registered');
        value = await Module.phpWasm.hostCall(UTF8ToString(name), UTF8ToString(payload));
        if (typeof value !== 'string') throw new TypeError('Host bridge must return a string');
        HEAP32[failed >> 2] = 0;
    } catch (error) {
        value = String(error?.message ?? error);
        HEAP32[failed >> 2] = 1;
    }
    const length = lengthBytesUTF8(value) + 1;
    const result = _malloc(length);
    if (!result) return 0;
    stringToUTF8(value, result, length);
    return result;
});

ZEND_BEGIN_ARG_WITH_RETURN_TYPE_INFO_EX(arginfo_php_wasm_host_call, 0, 2, IS_STRING, 0)
    ZEND_ARG_TYPE_INFO(0, name, IS_STRING, 0)
    ZEND_ARG_TYPE_INFO(0, payload, IS_STRING, 0)
ZEND_END_ARG_INFO()

PHP_FUNCTION(php_wasm_host_call)
{
    char *name, *payload; size_t name_length, payload_length;
    ZEND_PARSE_PARAMETERS_START(2, 2)
        Z_PARAM_STRING(name, name_length)
        Z_PARAM_STRING(payload, payload_length)
    ZEND_PARSE_PARAMETERS_END();
    if (memchr(name, 0, name_length) || memchr(payload, 0, payload_length)) {
        zend_value_error("Bridge name and payload cannot contain NUL bytes");
        RETURN_THROWS();
    }
    int failed = 0;
    char *result = host_call(name, payload, &failed);
    if (!result) { zend_throw_error(NULL, "Unable to allocate host bridge response"); RETURN_THROWS(); }
    if (failed) { zend_throw_exception(zend_ce_exception, result, 0); free(result); RETURN_THROWS(); }
    RETVAL_STRING(result);
    free(result);
}

static const zend_function_entry bridge_functions[] = {
    PHP_FE(php_wasm_host_call, arginfo_php_wasm_host_call)
    PHP_FE_END
};
static size_t write_output(const char *buffer, size_t length) { host_stdout(buffer, length); return length; }
static void flush_output(void *context) { (void) context; }
static void log_message(const char *message, int type) { (void) type; host_stderr(message); }
static size_t read_post(char *buffer, size_t length)
{
    size_t read = host_read_body(buffer, length, body_offset);
    body_offset += read;
    return read;
}
static char *read_cookies(void) { return SG(request_info).cookie_data; }
static void register_variables(zval *variables)
{
    php_import_environment_variables(variables);
    server_variables = variables;
    host_server_variables();
    server_variables = NULL;
}
static int send_headers(sapi_headers_struct *headers)
{
    zend_llist_position position;
    sapi_header_struct *header;
    host_headers_begin(headers->http_response_code);
    for (header = zend_llist_get_first_ex(&headers->headers, &position); header;
         header = zend_llist_get_next_ex(&headers->headers, &position)) host_header(header->header);
    if (headers->send_default_content_type) {
        sapi_header_struct default_header;
        sapi_get_default_content_type_header(&default_header);
        host_header(default_header.header);
        sapi_free_header(&default_header);
    }
    host_headers_end();
    return SAPI_HEADER_SENT_SUCCESSFULLY;
}
static int startup(sapi_module_struct *module) { return php_module_startup(module, NULL); }

static sapi_module_struct wasm_sapi = {
    .name = "cgi-fcgi", .pretty_name = "JoomEngine WebAssembly",
    .startup = startup, .shutdown = php_module_shutdown_wrapper,
    .ub_write = write_output, .flush = flush_output, .sapi_error = php_error,
    .send_headers = send_headers, .read_post = read_post, .read_cookies = read_cookies,
    .register_server_variables = register_variables, .log_message = log_message
};

static void register_cli_streams(void)
{
    const char *names[] = { "STDIN", "STDOUT", "STDERR" };
    const char *paths[] = { "php://stdin", "php://stdout", "php://stderr" };
    for (int i = 0; i < 3; i++) {
        php_stream *stream = php_stream_open_wrapper(paths[i], i ? "wb" : "rb", 0, NULL);
        if (!stream) continue;
        /* PHP request resources must not close the host's process-wide FDs. */
        stream->flags |= PHP_STREAM_FLAG_NO_RSCR_DTOR_CLOSE;
        zend_constant constant;
        php_stream_to_zval(stream, &constant.value);
        constant.name = zend_string_init(names[i], strlen(names[i]), 0);
        ZEND_CONSTANT_SET_FLAGS(&constant, 0, 0);
        zend_register_constant(&constant);
    }
}

/* argv[0] is the script name. Caller retains all arguments until Promise settles. */
EMSCRIPTEN_KEEPALIVE int php_wasm_run(const char *script, int cli, int argc, char **argv)
{
    if (running) return 70;
    running = 1; body_offset = 0;
    /* Emscripten's JavaScript ENV map is cached by libc on initialization. */
    clearenv();
    if (!host_environment()) { running = 0; return 70; }
    volatile int exit_status = 1, request_started = 0;
    int module_started = 0;
    char *method = host_string("method"), *uri = host_string("uri");
    char *query = host_string("query"), *type = host_string("contentType");
    char *cookie = host_string("cookie"), *ini = host_string("ini");
    char *filename = strdup(script);

    if (!method || !uri || !query || !type || !cookie || !ini || !filename) {
        free(method); free(uri); free(query); free(type); free(cookie); free(ini); free(filename);
        running = 0;
        return 70;
    }

    wasm_sapi.name = cli ? "cli" : "cgi-fcgi";
    wasm_sapi.phpinfo_as_text = cli;
    wasm_sapi.php_ini_ignore_cwd = 1;
    wasm_sapi.executable_location = "php-wasm";
    zend_signal_startup();
    sapi_startup(&wasm_sapi);
    wasm_sapi.ini_entries = ini;
    wasm_sapi.additional_functions = bridge_functions;
    if (wasm_sapi.startup(&wasm_sapi) == FAILURE) goto cleanup;
    module_started = 1;
    SG(options) |= SAPI_OPTION_NO_CHDIR;
    SG(request_info).request_method = cli ? NULL : method;
    SG(request_info).request_uri = uri;
    SG(request_info).query_string = query;
    SG(request_info).content_type = type;
    SG(request_info).content_length = host_body_length();
    SG(request_info).cookie_data = cookie;
    SG(request_info).path_translated = filename;
    SG(request_info).argc = argc;
    SG(request_info).argv = argv;
    SG(request_info).proto_num = 1001;
    SG(request_info).no_headers = cli;
    SG(request_info).headers_only = !cli && strcmp(method, "HEAD") == 0;
    SG(sapi_headers).http_response_code = 200;

    zend_first_try {
        /* Do not jump past zend_end_try: it restores the previous bailout target. */
        if (php_request_startup() == SUCCESS) {
            request_started = 1;
            if (cli) {
                SG(headers_sent) = 1;
                register_cli_streams();
            }
            zend_file_handle file;
            zend_stream_init_filename(&file, script);
            php_execute_script(&file);
            zend_destroy_file_handle(&file);
            exit_status = EG(exit_status);
        }
    } zend_catch {
        exit_status = EG(exit_status) ? EG(exit_status) : 255;
    } zend_end_try();
    if (request_started) {
        zend_first_try {
            php_request_shutdown(NULL);
            /* Shutdown callbacks can change the process exit code. */
            exit_status = EG(exit_status);
        } zend_catch {
            exit_status = EG(exit_status) ? EG(exit_status) : 255;
        } zend_end_try();
        request_started = 0;
    }
cleanup:
    if (module_started) php_module_shutdown();
    sapi_shutdown();
    free(method); free(uri); free(query); free(type); free(cookie); free(ini); free(filename);
    server_variables = NULL;
    running = 0;
    return exit_status;
}
