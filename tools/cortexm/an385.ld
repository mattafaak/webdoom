/* tools/cortexm/an385.ld — mps2-an385 (board.h has the map and its source). */
MEMORY
{
  CODE  (rwx) : ORIGIN = 0x00000000, LENGTH = 4M   /* ZBT SSRAM1 */
  ZONE  (rw)  : ORIGIN = 0x20000000, LENGTH = 4M   /* ZBT SSRAM2/3 */
  PSRAM (rw)  : ORIGIN = 0x21000000, LENGTH = 16M  /* PSRAM */
}
REGION_ALIAS("BIG", PSRAM);
INCLUDE sections.ld
