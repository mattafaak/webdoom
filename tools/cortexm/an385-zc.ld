/* tools/cortexm/an385-zc.ld — the zero-copy build (Makefile ZC=1), mps2-an385
 * (board.h has the map and its source). */
MEMORY
{
  CODE  (rwx) : ORIGIN = 0x00000000, LENGTH = 4M   /* ZBT SSRAM1 */
  ZONE  (rw)  : ORIGIN = 0x20000000, LENGTH = 4M   /* ZBT SSRAM2/3 */
  PSRAM (rw)  : ORIGIN = 0x21000000, LENGTH = 16M  /* PSRAM */
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
