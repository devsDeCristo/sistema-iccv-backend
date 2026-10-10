import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** O ID token que o botão "Entrar com Google" entregou ao front */
export class GoogleLoginDto {
  @ApiProperty({ description: 'ID token (JWT) do Google Identity Services' })
  @IsString()
  // um ID token tem por volta de 1 KB: o teto só barra lixo
  @MaxLength(4096)
  credential: string;
}

export class VincularGoogleDto extends GoogleLoginDto {
  @ApiPropertyOptional({ description: 'Senha atual, para confirmar o vínculo' })
  @IsOptional()
  @IsString()
  @MaxLength(72)
  currentPassword?: string;
}

/** O código de 8 dígitos que foi para o e-mail do cadastro */
export class ConfirmarVinculoDto {
  @ApiProperty({ example: '12345678' })
  @IsString()
  @Matches(/^\d{8}$/, { message: 'O código tem 8 dígitos.' })
  code: string;
}
