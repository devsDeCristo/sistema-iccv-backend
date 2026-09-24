import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsBoolean, IsOptional } from 'class-validator';

export class AceitarTermosDto {
  /** Explícito de propósito: o aceite é uma declaração, não um efeito colateral */
  @ApiProperty({ example: true })
  @Equals(true, { message: 'É preciso aceitar os Termos de Uso' })
  accepted: true;

  /**
   * Decisão sobre saúde e religião já guardados. `false` apaga os dados;
   * omitido, nada muda.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  sensitiveDataConsent?: boolean;
}
