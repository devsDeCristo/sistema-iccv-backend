import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class SavePluggyDto {
  /**
   * UUID: se não for, o mais comum é ter sido trocado com o secret, e a
   * recusa aqui poupa a pessoa de descobrir isso só no teste.
   */
  @ApiPropertyOptional({
    description:
      'Client ID da aplicação no dashboard da Pluggy. Em branco mantém o gravado.',
  })
  @IsOptional()
  @IsUUID('all', {
    message:
      'O Client ID é um UUID (ex.: c4a6d91e-f78a-…). Confira se não trocou com o Client Secret.',
  })
  clientId?: string;

  @ApiPropertyOptional({
    description: 'Client Secret da aplicação. Em branco mantém o gravado.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  clientSecret?: string;

  /** Um por banco conectado no MeuPluggy. 20 é folga: o plano grátis tem 5. */
  @ApiProperty({ type: [String], description: 'Item IDs, um por banco' })
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true, message: 'Cada Item ID é um UUID' })
  itemIds: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
