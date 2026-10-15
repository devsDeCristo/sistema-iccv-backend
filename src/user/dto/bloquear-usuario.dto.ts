import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class BloquearUsuarioDto {
  @ApiProperty({
    example: 'Inscrições falsas em nome de terceiros',
    description:
      'Por que a conta foi bloqueada. Interno: só o super admin vê; a pessoa recebe um aviso genérico.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3, { message: 'Escreva o motivo do bloqueio' })
  @MaxLength(500, { message: 'O motivo pode ter até 500 caracteres' })
  reason: string;
}
