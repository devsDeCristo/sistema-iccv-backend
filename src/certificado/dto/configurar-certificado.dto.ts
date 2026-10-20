import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const aparar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Teto da imagem de assinatura, já em base64. Uma assinatura escaneada e
 * recortada tem dezenas de KB; o teto barra foto de celular inteira, que
 * engordaria cada página do PDF.
 */
export const TAMANHO_MAXIMO_DA_ASSINATURA = 400_000;

export class AssinaturaDto {
  @ApiProperty({ example: 'Pr. João da Silva' })
  @Transform(aparar)
  @IsString()
  @MinLength(2, { message: 'Informe o nome de quem assina' })
  @MaxLength(80)
  name: string;

  @ApiProperty({ example: 'Pastor presidente' })
  @Transform(aparar)
  @IsString()
  @MaxLength(80)
  role: string;

  @ApiProperty({
    description: 'Imagem da assinatura em data URI (PNG ou JPEG), ou nula',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, {
    message: 'A assinatura precisa ser uma imagem PNG ou JPG',
  })
  @MaxLength(TAMANHO_MAXIMO_DA_ASSINATURA, {
    message: 'A imagem da assinatura está grande demais (até ~300 KB)',
  })
  signature?: string | null;
}

export class ConfigurarCertificadoDto {
  @ApiProperty({ description: 'Liga o certificado do evento' })
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({ example: '20 horas', required: false, nullable: true })
  @IsOptional()
  @Transform(aparar)
  @IsString()
  @MaxLength(40)
  workload?: string | null;

  @ApiProperty({ type: [AssinaturaDto], description: 'Até duas pessoas' })
  @IsArray()
  @ArrayMaxSize(2, { message: 'O certificado tem no máximo duas assinaturas' })
  @ValidateNested({ each: true })
  @Type(() => AssinaturaDto)
  signers: AssinaturaDto[];
}

/** O que vai para `event_certificates` — no cadastro e na edição do evento */
export const certificadoParaGravar = (dto: ConfigurarCertificadoDto) => ({
  enabled: dto.enabled,
  workload: dto.workload?.trim() || null,
  signers: dto.signers.map((s) => ({
    name: s.name,
    role: s.role ?? '',
    signature: s.signature ?? null,
  })),
});

export class CertificadosDosMarcadosDto {
  @ApiProperty({ type: [String], description: 'Os inscritos marcados' })
  @IsArray()
  @ArrayMinSize(1, { message: 'Marque ao menos uma pessoa' })
  // acima disso é engano, não um evento de verdade
  @ArrayMaxSize(3000, { message: 'São no máximo 3000 certificados por vez' })
  @IsString({ each: true })
  userIds: string[];
}
