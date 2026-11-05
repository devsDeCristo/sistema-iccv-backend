import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChurchRequestStatus } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

/**
 * Os ministérios que pedem. Texto, e não enum no banco, para a lista crescer
 * sem migração; a tela do `ic-front` tem a mesma lista
 * (`src/features/solicitacoes/constants.ts`). "Outro" cobre o que não está aqui.
 */
export const MINISTERIOS = [
  'Louvor',
  'Mídia',
  'Som e iluminação',
  'Infantil',
  'Jovens',
  'Recepção',
  'Intercessão',
  'Ação social',
  'Diaconia',
  'Ensino',
  'Casais',
  'Outro',
] as const;

export class CriarSolicitacaoDto {
  @ApiProperty({ enum: MINISTERIOS, example: 'Louvor' })
  @IsIn(MINISTERIOS, { message: 'Escolha o ministério que está pedindo' })
  ministerio: string;

  @ApiProperty({ example: 'Pedestal de microfone' })
  @IsString()
  @IsNotEmpty({ message: 'Diga o que está sendo pedido' })
  @MaxLength(120)
  titulo: string;

  @ApiProperty({ example: 'O pedestal do vocal quebrou no culto de domingo.' })
  @IsString()
  @IsNotEmpty({ message: 'Explique o pedido' })
  @MaxLength(2000)
  descricao: string;

  @ApiPropertyOptional({ example: 'https://loja.com.br/pedestal-microfone' })
  @IsOptional()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'O link do produto precisa começar com http:// ou https://' },
  )
  @MaxLength(500)
  link?: string;
}

export class MudarStatusDto {
  @ApiProperty({ enum: ChurchRequestStatus })
  @IsEnum(ChurchRequestStatus, { message: 'Situação inválida' })
  status: ChurchRequestStatus;

  @ApiPropertyOptional({
    description: 'O que o membro lê junto da situação: o motivo, o prazo',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  resposta?: string;
}
