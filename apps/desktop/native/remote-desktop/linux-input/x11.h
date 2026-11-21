#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <dlfcn.h>

static Display *xdisplay;
static int xorigin, yorigin, xwidth, xheight;
static double xwheel, ywheel;
static bool use_x11;
static Bool (*xtest_query)(Display *, int *, int *, int *, int *);
static int (*xtest_key)(Display *, unsigned int, Bool, unsigned long);
static int (*xtest_button)(Display *, unsigned int, Bool, unsigned long);
static int (*xtest_move)(Display *, int, int, int, unsigned long);
static uint32_t codepoint(const unsigned char **cursor);

static bool x11_open(char **geometry) {
  const char *session = getenv("XDG_SESSION_TYPE");
  const char *wayland = getenv("WAYLAND_DISPLAY");
  const char *address = getenv("DISPLAY");
  if (!session || strcmp(session, "x11") || (wayland && *wayland) ||
      !address || getuid() == 0 || getuid() != geteuid())
    return false;
  const char *name = strncmp(address, "unix:", 5) == 0 ? address + 4 : address;
  if (*name++ != ':')
    return false;
  size_t digits = strspn(name, "0123456789");
  if (!digits || (name[digits] && strcmp(name + digits, ".0")))
    return false;
  /* Wayland retains its own input path on systems without the XTest library. */
  void *xtest = dlopen("libXtst.so.6", RTLD_NOW | RTLD_LOCAL);
  if (!xtest)
    return false;
  xtest_query = dlsym(xtest, "XTestQueryExtension");
  xtest_key = dlsym(xtest, "XTestFakeKeyEvent");
  xtest_button = dlsym(xtest, "XTestFakeButtonEvent");
  xtest_move = dlsym(xtest, "XTestFakeMotionEvent");
  if (!xtest_query || !xtest_key || !xtest_button || !xtest_move)
    return false;
  xdisplay = XOpenDisplay(address);
  if (!xdisplay)
    return false;
  int event, error, major, minor;
  if (!xtest_query(xdisplay, &event, &error, &major, &minor))
    return false;
  if (!geometry)
    return true;
  int *values[] = {&xorigin, &yorigin, &xwidth, &xheight};
  for (int i = 0; i < 4; i++) {
    char *end;
    errno = 0;
    long value = strtol(geometry[i], &end, 10);
    if (errno || !*geometry[i] || *end || value < 0 || value > 32767)
      return false;
    *values[i] = (int)value;
  }
  const int screen = DefaultScreen(xdisplay);
  return xwidth > 0 && xheight > 0 &&
         xorigin + xwidth <= DisplayWidth(xdisplay, screen) &&
         yorigin + xheight <= DisplayHeight(xdisplay, screen);
}

static void x11_key(uint32_t code, bool down) {
  /* Xorg reserves the first eight keycodes before the kernel evdev range. */
  if (code + 8 <= 255)
    xtest_key(xdisplay, code + 8, down, CurrentTime);
}

static void x11_move(double x, double y) {
  xtest_move(xdisplay, DefaultScreen(xdisplay),
             xorigin + (int)llround(x * (xwidth - 1)),
             yorigin + (int)llround(y * (xheight - 1)), CurrentTime);
}

static void x11_button(int button, bool down) {
  xtest_button(xdisplay, (unsigned)button + 1, down, CurrentTime);
}

static void x11_wheel(double *remainder, double delta, unsigned negative,
                      unsigned positive) {
  *remainder += delta;
  while (fabs(*remainder) >= 40 && !stopping) {
    unsigned button = *remainder < 0 ? negative : positive;
    xtest_button(xdisplay, button, True, CurrentTime);
    xtest_button(xdisplay, button, False, CurrentTime);
    *remainder += *remainder < 0 ? 40 : -40;
  }
}

static void x11_scroll(double dx, double dy) {
  x11_wheel(&xwheel, dx, 6, 7);
  x11_wheel(&ywheel, dy, 4, 5);
}

/* Use an unpressed spare key and restore its exact mapping before the receipt.
 * Every level carries the character. The user's clipboard is untouched. */
static bool x11_text(const char *text) {
  int minimum, maximum, per_key;
  XDisplayKeycodes(xdisplay, &minimum, &maximum);
  KeySym *mapping = XGetKeyboardMapping(xdisplay, minimum, maximum - minimum + 1, &per_key);
  if (!mapping)
    return false;
  char held[32];
  XQueryKeymap(xdisplay, held);
  int spare = 0;
  for (int key = maximum; key >= minimum && !spare; key--) {
    bool empty = !(held[key / 8] & (1 << (key % 8)));
    for (int level = 0; level < per_key; level++)
      if (mapping[(key - minimum) * per_key + level] != NoSymbol)
        empty = false;
    if (empty)
      spare = key;
  }
  KeySym *symbols = spare ? calloc((size_t)per_key, sizeof(*symbols)) : NULL;
  if (!symbols) {
    XFree(mapping);
    return false;
  }
  const unsigned char *cursor = (const unsigned char *)text;
  while (*cursor && !stopping) {
    uint32_t c = codepoint(&cursor);
    KeySym sym = c == '\r' || c == '\n' ? XKB_KEY_Return
                 : c == '\t' ? XKB_KEY_Tab : xkb_utf32_to_keysym(c);
    for (int level = 0; level < per_key; level++)
      symbols[level] = sym;
    XChangeKeyboardMapping(xdisplay, spare, per_key, symbols, 1);
    XSync(xdisplay, False);
    xtest_key(xdisplay, spare, True, 10);
    xtest_key(xdisplay, spare, False, 10);
    XSync(xdisplay, False);
    struct timespec pace = {.tv_nsec = 10000000};
    nanosleep(&pace, NULL);
  }
  XChangeKeyboardMapping(xdisplay, spare, per_key, mapping + (spare - minimum) * per_key, 1);
  XSync(xdisplay, False);
  free(symbols);
  XFree(mapping);
  return !stopping;
}
