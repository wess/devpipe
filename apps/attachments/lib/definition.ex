#
#  definition.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

defmodule Definition do
  use Waffle.Definition
  use Waffle.Ecto.Definition

  @acl      :public_read

  def validate({file, _}) do
  ~w(.jpg .jpeg .png .gif .bmp .psd .tif .html .htm .txt .docx .doc .zip .pdf .ppt .pptx .xls .xlsx .xlsm)
      |> Enum.member?(
          file.file_name 
          |> String.downcase 
          |> Path.extname
        )
    
  end

  def filename(_, {file, _}) do
    [ name | _ ] = 
      file.file_name
      |> String.split(".")

    Zarex.sanitize(
      name 
      |> String.downcase
    )
  end
  
  def transform(:original, {file, _}) do
    if ~w(.jpg .jpeg .png .gif .bmp) |> Enum.member?(file.file_name |> String.downcase |> Path.extname) do
      {:convert, "-resize 960x2000\>"}
    else
      :noaction
    end
  end
end
