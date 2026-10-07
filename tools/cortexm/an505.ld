/* tools/cortexm/an505.ld — mps2-an505, Secure aliases (board.h has the map). */
MEMORY
{
  CODE  (rwx) : ORIGIN = 0x10000000, LENGTH = 4M   /* SSRAM1; init-svtor */
  ZONE  (rw)  : ORIGIN = 0x38000000, LENGTH = 4M   /* SSRAM2 + SSRAM3 */
  PSRAM (rw)  : ORIGIN = 0x80000000, LENGTH = 16M  /* PSRAM */
}
INCLUDE sections.ld
