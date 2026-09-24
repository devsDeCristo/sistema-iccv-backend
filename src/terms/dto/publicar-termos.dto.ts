import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PublicarTermosDto {
  /** HTML do editor. A página pública o limpa antes de mostrar. */
  @ApiProperty()
  @IsString()
  @MinLength(50, { message: 'O texto dos termos está curto demais' })
  @MaxLength(200_000)
  content: string;

  /** As frases do quadro "Em resumo" */
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  summary: string[];

  /**
   * Mudança relevante: todo mundo aceita de novo no próximo acesso. Desligado
   * é correção de texto, publicada sem pedir aceite.
   */
  @ApiProperty()
  @IsBoolean()
  requiresAcceptance: boolean;
}
