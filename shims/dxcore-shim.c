/*
 * sprkdx.dll wraps Wine's dxcore.dll for onnxruntime.dll.
 *
 * Wine lists the GPU, but IDXCoreAdapter::IsAttributeSupported returns false for
 * every attribute, and IDXCoreAdapterList::Sort is not implemented. ONNX Runtime
 * filters adapters on those answers, finds none, and Spark reports that the device
 * cannot run its AI Assistant. D3D12 and DirectML themselves work on the same
 * adapter. This corrects the answers by patching the interface tables in place.
 * See docs/investigation.md.
 */
typedef void *HMODULE;
typedef long HRESULT;
typedef unsigned int UINT;
typedef unsigned long DWORD;
typedef unsigned long long SIZE_T;
typedef struct { unsigned int a; unsigned short b, c; unsigned char d[8]; } GUID;

__declspec(dllimport) HMODULE __stdcall LoadLibraryA(const char *);
__declspec(dllimport) void *__stdcall GetProcAddress(HMODULE, const char *);
__declspec(dllimport) int __stdcall VirtualProtect(void *, SIZE_T, DWORD, DWORD *);
__declspec(dllimport) int __stdcall GetModuleHandleExA(DWORD, const char *, HMODULE *);

#define S_OK 0
#define E_FAIL ((HRESULT)0x80004005)
#define PAGE_READWRITE 4
#define MODULE_PIN_FROM_ADDRESS 5 /* GET_MODULE_HANDLE_EX_FLAG_PIN | _FROM_ADDRESS */
#define PROPERTY_IS_INTEGRATED 12
#define PROPERTY_IS_DETACHABLE 13

static const GUID SUPPORTED[] = {
    {0x248e2800, 0xa793, 0x4724, {0xab, 0xaa, 0x23, 0xa6, 0xde, 0x1b, 0xe0, 0x90}}, /* D3D12 core compute */
    {0x0c9ece4d, 0x2f6e, 0x4f01, {0x8c, 0x96, 0xe8, 0x9e, 0x33, 0x1b, 0x47, 0xb1}}, /* D3D12 graphics */
    {0x8c47866b, 0x7583, 0x450d, {0xf0, 0xf0, 0x6b, 0xad, 0xa8, 0x95, 0xaf, 0x4b}}, /* D3D11 graphics */
    {0xb71b0d41, 0x1088, 0x422f, {0xa2, 0x7c, 0x02, 0x50, 0xb7, 0xd3, 0xa9, 0x88}}, /* D3D12 generic ML */
};

typedef HRESULT(__stdcall *create_factory_fn)(const GUID *, void **);
typedef HRESULT(__stdcall *create_list_fn)(void *, UINT, const GUID *, const GUID *, void **);
typedef HRESULT(__stdcall *get_adapter_fn)(void *, UINT, const GUID *, void **);
typedef unsigned char(__stdcall *attribute_fn)(void *, const GUID *);
typedef HRESULT(__stdcall *get_property_fn)(void *, int, SIZE_T, void *);
typedef HRESULT(__stdcall *property_size_fn)(void *, int, SIZE_T *);

static create_list_fn real_create_list;
static get_adapter_fn real_get_adapter;
static attribute_fn real_is_attribute_supported;
static get_property_fn real_get_property;
static property_size_fn real_get_property_size;

static void hook(void *object, int slot, void *replacement, void **original)
{
    void **entry = *(void ***)object + slot;
    DWORD protection;

    if (*entry == replacement || !VirtualProtect(entry, sizeof(void *), PAGE_READWRITE, &protection))
        return;
    if (original)
        *original = *entry;
    *entry = replacement;
    VirtualProtect(entry, sizeof(void *), protection, &protection);
}

static int same_guid(const GUID *left, const GUID *right)
{
    const unsigned char *a = (const unsigned char *)left, *b = (const unsigned char *)right;
    int i;

    for (i = 0; i < (int)sizeof(GUID); i++)
        if (a[i] != b[i])
            return 0;
    return 1;
}

static int is_filled_in(int property)
{
    return property == PROPERTY_IS_INTEGRATED || property == PROPERTY_IS_DETACHABLE;
}

static unsigned char __stdcall is_attribute_supported(void *self, const GUID *attribute)
{
    int i;

    for (i = 0; i < (int)(sizeof(SUPPORTED) / sizeof(SUPPORTED[0])); i++)
        if (same_guid(attribute, &SUPPORTED[i]))
            return 1;
    return real_is_attribute_supported(self, attribute);
}

static HRESULT __stdcall get_property_size(void *self, int property, SIZE_T *size)
{
    if (is_filled_in(property)) {
        *size = 1;
        return S_OK;
    }
    return real_get_property_size(self, property, size);
}

static unsigned char __stdcall is_property_supported(void *self, int property)
{
    SIZE_T size;

    return get_property_size(self, property, &size) >= 0;
}

static HRESULT __stdcall get_property(void *self, int property, SIZE_T size, void *value)
{
    if (is_filled_in(property)) {
        if (size < 1)
            return E_FAIL;
        *(unsigned char *)value = 0;
        return S_OK;
    }
    return real_get_property(self, property, size, value);
}

static HRESULT __stdcall get_adapter(void *self, UINT index, const GUID *iid, void **adapter)
{
    HRESULT result = real_get_adapter(self, index, iid, adapter);

    if (result >= 0 && *adapter) {
        hook(*adapter, 4, is_attribute_supported, (void **)&real_is_attribute_supported);
        hook(*adapter, 5, is_property_supported, 0);
        hook(*adapter, 6, get_property, (void **)&real_get_property);
        hook(*adapter, 7, get_property_size, (void **)&real_get_property_size);
    }
    return result;
}

static HRESULT __stdcall sort_adapters(void *self, UINT count, const int *preferences)
{
    (void)self;
    (void)count;
    (void)preferences;
    return S_OK;
}

static HRESULT __stdcall create_list(void *self, UINT count, const GUID *filters, const GUID *iid, void **list)
{
    HRESULT result = real_create_list(self, count, filters, iid, list);

    if (result >= 0 && *list) {
        hook(*list, 3, get_adapter, (void **)&real_get_adapter);
        hook(*list, 7, sort_adapters, 0);
    }
    return result;
}

__declspec(dllexport) HRESULT __stdcall DXCoreCreateAdapterFactory(const GUID *iid, void **factory)
{
    HMODULE wine_dxcore = LoadLibraryA("dxcore.dll");
    create_factory_fn create;
    HMODULE self;
    HRESULT result;

    /* ONNX Runtime frees this DLL between uses, but Wine's interface tables are
     * shared and keep pointing here. Unloading would leave them dangling. */
    if (!GetModuleHandleExA(MODULE_PIN_FROM_ADDRESS, (const char *)&real_create_list, &self))
        return E_FAIL;
    create = wine_dxcore ? (create_factory_fn)GetProcAddress(wine_dxcore, "DXCoreCreateAdapterFactory") : 0;
    if (!create)
        return E_FAIL;
    result = create(iid, factory);
    if (result >= 0 && *factory)
        hook(*factory, 3, create_list, (void **)&real_create_list);
    return result;
}

int __stdcall DllMainCRTStartup(void *module, DWORD reason, void *reserved)
{
    (void)module;
    (void)reason;
    (void)reserved;
    return 1;
}
