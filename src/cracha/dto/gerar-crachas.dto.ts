import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CrachaDto {
  /** A inscrição que o QR aponta. Sem ele o crachá sai só com o nome. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;

  /**
   * O nome como vai impresso. A formatação (caixa, duas palavras) é escolha
   * de quem gera, no modal — o servidor imprime o que veio.
   */
  @ApiProperty()
  @IsString()
  @MaxLength(120)
  name: string;
}

export class SecaoDeCrachasDto {
  /** Cabeçalho da folha: equipe ou grupo de inscrição */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string | null;

  @ApiProperty({ type: [CrachaDto] })
  @IsArray()
  @ArrayMaxSize(3000)
  @ValidateNested({ each: true })
  @Type(() => CrachaDto)
  badges: CrachaDto[];
}

export class GerarCrachasDto {
  @ApiProperty({ type: [SecaoDeCrachasDto] })
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => SecaoDeCrachasDto)
  sections: SecaoDeCrachasDto[];

  /** Crachás sem nome, no fim, para quem chega sem inscrição */
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  blankCount?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  withQrCode?: boolean;
}
