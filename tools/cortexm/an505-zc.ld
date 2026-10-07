/* tools/cortexm/an505-zc.ld — the zero-copy build (Makefile ZC=1), mps2-an505
 * Secure aliases (board.h has the map). */
MEMORY
{
  CODE  (rwx) : ORIGIN = 0x10000000, LENGTH = 4M   /* SSRAM1; init-svtor */
  ZONE  (rw)  : ORIGIN = 0x38000000, LENGTH = 4M   /* SSRAM2 + SSRAM3 */
  PSRAM (rw)  : ORIGIN = 0x80000000, LENGTH = 16M  /* PSRAM */
}
/* The WAD is read in place (WEB_LUMPS_IN_PLACE): PSRAM is its image, the
 * way a board's flash would be, and nothing else goes there.  A WAD longer
 * than PSRAM continues in .wadtail (sections.ld, wad_semi.c). */
REGION_ALIAS("BIG", CODE);
INCLUDE sections.ld
SECTIONS
{
  .wad (NOLOAD) : {
    _swad = .;
    . = ORIGIN(PSRAM) + LENGTH(PSRAM);
    _ewad = .;
  } > PSRAM
}
